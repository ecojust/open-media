"""Contract checks; actual model inference is covered by runtime platform smoke runs."""

import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("optional_speech_runner", ROOT / "tts.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class ModelConfigurationTests(unittest.TestCase):
    def test_precisions_and_voice_cannot_silently_change(self):
        for name, key, unsupported in (
            ("f5-v1-base-fp32", "dtype", "float16"),
            ("qwen3-tts-1.7b-serena", "dtype", "float32"),
            ("qwen3-tts-1.7b-serena", "speaker", "Other"),
            ("f5-v1-base-fp32", "steps", 8),
        ):
            with self.subTest(model=name, key=key), tempfile.TemporaryDirectory() as directory:
                source = ROOT / "config" / f"{name}.json"
                config, _ = runner.load_config(source)
                config[key] = unsupported
                target = Path(directory) / "runner-config.json"
                target.write_text(json.dumps(config), encoding="utf-8")
                with self.assertRaises(ValueError):
                    runner.load_config(target)

    def test_unicode_paths_work_but_package_escape_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            outer = Path(directory)
            root = outer / "本地 模型"
            root.mkdir()
            (root / "音频.wav").write_bytes(b"audio")
            (outer / "outside.bin").write_bytes(b"weight")
            self.assertEqual(runner.local_path(root, "音频.wav"), root / "音频.wav")
            self.assertEqual(runner.local_path(root, ".", directory=True), root)
            for path in ("../outside.bin", "/outside.bin", "C:/outside.bin", "..\\outside.bin", ".", ""):
                with self.subTest(path=path), self.assertRaises((ValueError, FileNotFoundError)):
                    runner.local_path(root, path)
            try:
                (root / "link.bin").symlink_to(outer / "outside.bin")
            except (OSError, NotImplementedError):
                return  # Some Windows accounts cannot create symbolic links.
            with self.assertRaises(ValueError):
                runner.local_path(root, "link.bin")

    def test_input_limits_reject_silent_or_unbounded_requests(self):
        with tempfile.TemporaryDirectory() as directory:
            text = Path(directory) / "text.txt"
            for content in ("   ", "，。！？", "话" * 4001, "你好\x00世界"):
                text.write_text(content, encoding="utf-8")
                with self.subTest(content=content[:20]), self.assertRaises(ValueError):
                    runner.read_text(text)
            text.write_text("\ufeff这是一款全程由AI接管并生成的软件\n", encoding="utf-8")
            self.assertEqual(runner.read_text(text), "这是一款全程由AI接管并生成的软件")


class ChunkingTests(unittest.TestCase):
    def test_first_comparison_sentence_is_unchanged(self):
        sentence = "这是一款全程由AI接管并生成的软件"
        self.assertEqual(runner.split_text(sentence, 200), [sentence])

    def test_long_unpunctuated_and_mixed_text_is_not_dropped(self):
        text = ("中文 mixed text 123，下一句很好。" * 15) + ("连续中文" * 80)
        chunks = runner.split_text(text, 97)
        self.assertTrue(len(chunks) > 1)
        self.assertTrue(all(len(chunk.encode("utf-8")) <= 97 for chunk in chunks))
        self.assertEqual("".join("".join(chunks).split()), "".join(text.split()))

    def test_generation_token_limit_does_not_return_truncated_audio(self):
        runner.verify_generation_stop([[1, 2, 99]], 99)
        for sequences in ([], [[]], [[1, 2, 3]], [[1, 99], [1, 99]]):
            with self.subTest(sequences=sequences), self.assertRaises(RuntimeError):
                runner.verify_generation_stop(sequences, 99)


class InvocationCacheTests(unittest.TestCase):
    def test_both_entry_paths_set_and_clean_an_external_cache(self):
        with tempfile.TemporaryDirectory(prefix="配音 测试 ") as directory:
            job = Path(directory)
            for self_test in (True, False):
                with self.subTest(self_test=self_test):
                    observed = []

                    def check_cache(args):
                        cache = Path(os.environ["NUMBA_CACHE_DIR"])
                        self.assertTrue(cache.is_dir())
                        self.assertFalse(cache.is_relative_to(ROOT.parent))
                        if not self_test:
                            self.assertTrue(cache.is_relative_to(job))
                        (cache / "compiled.nbc").write_bytes(b"cache")
                        observed.append(cache)

                    argv = [str(ROOT / "tts.py"), "--self-test"] if self_test else [
                        str(ROOT / "tts.py"), "--config", str(job / "config.json"),
                        "--text-file", str(job / "text.txt"),
                        "--output-filename", str(job / "output.wav")]
                    with patch.object(sys, "argv", argv), patch.dict(os.environ), \
                            patch.object(runner, "run", side_effect=check_cache):
                        runner.main()
                    self.assertEqual(len(observed), 1)
                    self.assertFalse(observed[0].exists())

    def test_error_cleans_cache_without_swallowing_generation_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = None
            with self.assertRaisesRegex(RuntimeError, "generation failed"):
                with runner.invocation_cache(Path(directory) / "output.wav") as cache:
                    (cache / "probe.nbc").write_bytes(b"cache")
                    raise RuntimeError("generation failed")
            self.assertIsNotNone(cache)
            self.assertFalse(cache.exists())

    def test_runtime_cannot_be_used_as_a_cache_workspace(self):
        with self.assertRaises(ValueError):
            with runner.invocation_cache(ROOT / "output.wav"):
                self.fail("Runtime tree must remain immutable")


class AudioContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            import numpy as np
            import soundfile as sf
        except ImportError:
            raise unittest.SkipTest("Run with the packaged runtime for audio-library probes")
        cls.np, cls.sf = np, sf

    def test_float_wav_roundtrip_retains_finite_peaks(self):
        np = self.np
        wave = np.array([0, 0.25, -0.5, 1.01, -1.01, 0], dtype=np.float32)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "中文 音频.wav"
            report = runner.write_audio(path, wave, np, self.sf)
            decoded, rate = self.sf.read(path, dtype="float32")
            self.assertEqual(rate, 24000)
            self.assertTrue(np.array_equal(decoded, wave))
            self.assertGreater(report["peak"], 1)
            self.assertFalse(path.with_name(path.name + ".part").exists())

    def test_failed_generation_preserves_previous_output(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "audio.wav"
            path.write_bytes(b"existing-output")
            for samples in ([], [0.0, 0.0], [float("nan"), 0.1]):
                with self.subTest(samples=samples), self.assertRaises(RuntimeError):
                    runner.write_audio(path, samples, self.np, self.sf)
                self.assertEqual(path.read_bytes(), b"existing-output")


if __name__ == "__main__":
    unittest.main()
