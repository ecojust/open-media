"""Voice selection and immutable-runtime boundaries; inference is checked separately."""

import importlib.util
import json
from pathlib import Path
import shutil
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


adapter = module("speech_voice_adapter", ROOT / "scripts/speech-voice-adapter.py")


class VoiceAdapterTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="男声 测试,")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.job = self.root / "任务"
        self.job.mkdir()
        self.models = self.root / "模型"
        self.models.mkdir()
        self.runtime = adapter.load_runtime(ROOT / "scripts/optional-speech-runner/tts.py", self.job)

    def config(self, engine):
        name = "f5-runner-config.json" if engine == "f5" else "qwen3-runner-config.json"
        path = self.models / "runner-config.json"
        shutil.copyfile(ROOT / "scripts/optional-speech-assets" / name, path)
        return path

    def references(self):
        (self.job / "male-reference.wav").write_bytes(b"reference checked by the audio engine")
        (self.job / "male-reference.txt").write_text("本地参考声音。", encoding="utf-8")

    def test_qwen_selects_real_model_speaker_without_changing_installed_files(self):
        config = self.config("qwen3")
        original = config.read_bytes()
        adapter.bind_voice(self.runtime, "qwen3_uncle_fu", config, self.job)
        selected, model = self.runtime.load_config(config)
        self.assertEqual(selected["speaker"], "Uncle_Fu")
        self.assertEqual(selected["dtype"], "bfloat16")
        self.assertEqual(model, self.models)
        selected["speaker"] = "Tampered"
        self.assertEqual(self.runtime.load_config(config)[0]["speaker"], "Uncle_Fu")
        self.assertEqual(config.read_bytes(), original)
        self.assertEqual(list(self.models.iterdir()), [config])

    def test_f5_only_substitutes_its_two_job_reference_files(self):
        config = self.config("f5")
        original = config.read_bytes()
        self.references()
        (self.models / "weight.bin").write_bytes(b"weight")
        adapter.bind_voice(self.runtime, "f5_zh_male", config, self.job)
        selected, model = self.runtime.load_config(config)
        for key, name in (("referenceAudio", "male-reference.wav"), ("referenceText", "male-reference.txt")):
            marker = selected[key]
            self.assertEqual(self.runtime.local_path(model, marker), self.job / name)
            for root, directory in ((self.job, False), (model, True)):
                with self.assertRaises(ValueError):
                    self.runtime.local_path(root, marker, directory=directory)
        self.assertEqual(self.runtime.local_path(model, "weight.bin"), model / "weight.bin")
        for value in ("../任务/male-reference.wav", str(self.job / "male-reference.wav"), "C:/outside"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.runtime.local_path(model, value)
        self.assertEqual(config.read_bytes(), original)

    def test_unknown_voice_wrong_model_and_invalid_original_configuration_fail(self):
        config = self.config("qwen3")
        for voice in ("unavailable_voice", "arbitrary", "f5_zh_male"):
            with self.subTest(voice=voice), self.assertRaises(ValueError):
                adapter.bind_voice(self.runtime, voice, config, self.job)
        data = json.loads(config.read_text())
        data["speaker"] = "Uncle_Fu"
        config.write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError, "Unsupported model voice"):
            adapter.bind_voice(self.runtime, "qwen3_uncle_fu", config, self.job)

    def test_female_voices_preserve_the_verified_configuration_and_references(self):
        for voice, engine in (("f5_zh_female", "f5"), ("qwen3_serena", "qwen3")):
            with self.subTest(voice=voice):
                runtime = adapter.load_runtime(ROOT / "scripts/optional-speech-runner/tts.py", self.job)
                config = self.config(engine)
                expected, expected_root = runtime.load_config(config)
                original = config.read_bytes()
                adapter.bind_voice(runtime, voice, config, self.job)
                actual, root = runtime.load_config(config)
                self.assertEqual(actual, expected)
                self.assertEqual(root, expected_root)
                self.assertEqual(config.read_bytes(), original)
                self.assertEqual(list(self.job.iterdir()), [])

    def test_job_cannot_be_inside_the_model_and_configs_cannot_change(self):
        config = self.config("qwen3")
        nested = self.models / "job"
        nested.mkdir()
        with self.assertRaises(ValueError):
            adapter.bind_voice(self.runtime, "qwen3_uncle_fu", config, nested)
        adapter.bind_voice(self.runtime, "qwen3_uncle_fu", config, self.job)
        other = self.models / "other.json"
        shutil.copyfile(config, other)
        with self.assertRaises(ValueError):
            self.runtime.load_config(other)

    def test_references_reject_missing_oversized_and_symlinked_files(self):
        config = self.config("f5")
        with self.assertRaises(ValueError):
            adapter.bind_voice(self.runtime, "f5_zh_male", config, self.job)
        self.references()
        (self.job / "male-reference.txt").write_bytes(b"x" * 4097)
        with self.assertRaises(ValueError):
            adapter.bind_voice(self.runtime, "f5_zh_male", config, self.job)
        self.references()
        target = self.job / "male-reference.wav"
        target.unlink()
        outside = self.root / "outside.wav"
        outside.write_bytes(b"outside")
        try:
            target.symlink_to(outside)
        except OSError:
            self.skipTest("Creating symbolic links is unavailable")
        with self.assertRaises(ValueError):
            adapter.bind_voice(self.runtime, "f5_zh_male", config, self.job)

    def test_reference_replacement_after_binding_is_rejected(self):
        config = self.config("f5")
        self.references()
        adapter.bind_voice(self.runtime, "f5_zh_male", config, self.job)
        target = self.job / "male-reference.wav"
        target.unlink()
        try:
            target.symlink_to(self.models / "runner-config.json")
        except OSError:
            self.skipTest("Creating symbolic links is unavailable")
        with self.assertRaises(ValueError):
            self.runtime.local_path(self.models, adapter.REFERENCE_AUDIO)

    def test_runtime_source_cannot_come_from_the_job(self):
        source = self.job / "tts.py"
        source.write_text("raise AssertionError('must not execute')")
        with self.assertRaises(ValueError):
            adapter.load_runtime(source, self.job)

    def test_device_module_must_be_an_application_owned_job_file(self):
        with self.assertRaises(ValueError):
            adapter.load_device_runtime(self.job)
        source = self.job / "speech-device-runtime.py"
        source.write_text("def run(runtime, args):\n    return 'loaded application module'\n")
        self.assertEqual(adapter.load_device_runtime(self.job).run(None, None), "loaded application module")
        source.unlink()
        outside = self.root / "unverified.py"
        outside.write_text("raise AssertionError('must not execute')")
        try:
            source.symlink_to(outside)
        except OSError:
            self.skipTest("Creating symbolic links is unavailable")
        with self.assertRaises(ValueError):
            adapter.load_device_runtime(self.job)

    def test_command_runs_with_isolated_cache_and_cleans_it_on_failure(self):
        config = self.config("qwen3")
        script = self.job / "speech-voice-adapter.py"
        script.write_bytes(b"application-owned script")
        text = self.job / "字幕.txt"
        text.write_text("这是一款全程由AI接管并生成的软件", encoding="utf-8")
        output = self.job / "生成.wav"
        argv = [str(script), "--runtime-script", str(ROOT / "scripts/optional-speech-runner/tts.py"),
                "--voice", "qwen3_uncle_fu", "--config", str(config),
                "--text-file", str(text), "--output-filename", str(output), "--speed", "1.25"]
        observed = []

        def configure(threads, cache):
            self.assertTrue(cache.is_relative_to(self.job))
            self.assertTrue(cache.is_dir())
            observed.append(cache)

        def generate(runtime, args):
            self.assertIs(runtime, self.runtime)
            self.assertEqual(args.speed, 1.25)
            self.assertEqual(args.device, "auto")
            self.assertFalse(args.self_test)
            self.assertEqual(self.runtime.load_config(args.config)[0]["speaker"], "Uncle_Fu")
            raise RuntimeError("synthesis failed")

        with patch.object(adapter, "__file__", str(script)), patch.object(sys, "argv", argv), \
                patch.object(adapter, "load_runtime", return_value=self.runtime), \
                patch.object(adapter, "load_device_runtime", return_value=types.SimpleNamespace(run=generate)), \
                patch.object(self.runtime, "configure_process", side_effect=configure), \
                patch.object(self.runtime, "run", side_effect=AssertionError("Use the selected device entry point")):
            with self.assertRaisesRegex(RuntimeError, "synthesis failed"):
                adapter.main()
        self.assertEqual(len(observed), 1)
        self.assertFalse(observed[0].exists())
        self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
