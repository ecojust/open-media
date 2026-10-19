#!/usr/bin/env python3
"""Adapter and download-contract checks, without loading music model weights."""

import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("music_runner", ROOT / "scripts/ai-music-runner.py")
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


class MusicAdapterTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.models = self.root / "models"
        self.models.mkdir()
        self.request = dict(modelId="ace-step-1.5-turbo", modelRoot=str(self.models),
                            outputPath=str(self.root / "generated.wav"), prompt="温暖的钢琴与弦乐")

    def test_defaults_choose_instrumental_without_lyrics_and_model_steps(self):
        parsed = runner.validate_request(self.request)
        self.assertTrue(parsed["instrumental"])
        self.assertEqual(parsed["lyrics"], "[Instrumental]")
        self.assertEqual((parsed["steps"], parsed["seconds"], parsed["guidance"]), (8, 30, 1))
        parsed = runner.validate_request({**self.request, "modelId": "ace-step-1.5-sft"})
        self.assertEqual((parsed["steps"], parsed["guidance"]), (50, 7))

    def test_lyrics_select_song_and_null_optional_fields_do_not_override_defaults(self):
        parsed = runner.validate_request({**self.request, "lyrics": "[Verse]\n迎着晨光出发",
                                          "device": None, "memoryMode": None, "seconds": None})
        self.assertFalse(parsed["instrumental"])
        self.assertEqual(parsed["device"], "auto")
        self.assertEqual(parsed["memoryMode"], "low")

    def test_unsupported_or_invalid_inputs_fail_before_runtime(self):
        bad = [dict(seconds=0), dict(seconds=601), dict(seconds=float("nan")), dict(steps=True),
               dict(steps=1.5), dict(bpm=301), dict(seed=-1), dict(seed=2**32),
               dict(guidance=7), dict(instrumental=False), dict(instrumental=True, lyrics="唱歌"),
               dict(negativePrompt="noise"), dict(inputPath="/audio.wav"), dict(modelId="arbitrary"),
               dict(memoryMode="unknown"), dict(device="arbitrary"), dict(prompt=" "),
               dict(outputPath=str(self.models / "weights.wav")), dict(outputPath="relative.wav")]
        for changed in bad:
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                runner.validate_request({**self.request, **changed})

    def test_existing_output_is_never_overwritten(self):
        output = Path(self.request["outputPath"])
        output.write_bytes(b"original")
        with self.assertRaises(ValueError):
            runner.validate_request(self.request)
        self.assertEqual(output.read_bytes(), b"original")

    def test_local_layout_rejects_missing_or_empty_weights(self):
        with self.assertRaisesRegex(ValueError, "文件缺失"):
            runner.verify_local_layout(self.models, "acestep-v15-turbo")
        for name in runner.required_files("acestep-v15-turbo"):
            path = self.models / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"contract-only-placeholder")
        runner.verify_local_layout(self.models, "acestep-v15-turbo")
        (self.models / "vae/diffusion_pytorch_model.safetensors").write_bytes(b"")
        with self.assertRaises(ValueError):
            runner.verify_local_layout(self.models, "acestep-v15-turbo")

    @unittest.skipIf(os.name == "nt", "Windows symlink creation can require elevated privileges")
    def test_layout_cannot_escape_download_directory(self):
        external = self.root / "external"
        external.mkdir()
        (external / "config.json").write_text("{}")
        (self.models / "acestep-v15-turbo").symlink_to(external, target_is_directory=True)
        with self.assertRaises(ValueError):
            runner.verify_local_layout(self.models, "acestep-v15-turbo")

    def test_gpu_priority_and_explicit_cpu_fallback(self):
        for cuda, mps, expected in [(True, True, "cuda"), (False, True, "mps"), (False, False, "cpu")]:
            torch = types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: cuda),
                                          backends=types.SimpleNamespace(mps=types.SimpleNamespace(is_available=lambda: mps)))
            self.assertEqual(runner.choose_device(torch, "auto"), expected)
            self.assertEqual(runner.choose_device(torch, "cpu"), "cpu")
        with self.assertRaises(RuntimeError):
            runner.choose_device(torch, "cuda")

    def test_offline_mode_has_no_hidden_model_downloads(self):
        with patch.dict(os.environ, {}, clear=True):
            runner.configure_offline(self.models, self.root / "cache")
            self.assertEqual(os.environ["HF_HUB_OFFLINE"], "1")
            self.assertEqual(os.environ["TRANSFORMERS_OFFLINE"], "1")
            self.assertEqual(os.environ["ACESTEP_CHECKPOINTS_DIR"], str(self.models))

    def test_source_revision_must_match_the_adapter(self):
        executable = self.root / "runtime/python/bin/python3"
        executable.parent.mkdir(parents=True)
        executable.write_bytes(b"contract-only")
        marker = self.root / "runtime/licenses/music-source/source.json"
        marker.parent.mkdir(parents=True)
        with self.assertRaises(RuntimeError):
            runner.verify_runtime_source(executable)
        marker.write_text(json.dumps({"revision": "wrong"}))
        with self.assertRaises(RuntimeError):
            runner.verify_runtime_source(executable)
        marker.write_text(json.dumps({"revision": runner.SOURCE_REVISION}))
        runner.verify_runtime_source(executable)

    def test_subprocess_failure_is_json_not_success_and_creates_no_audio(self):
        request_file = self.root / "request.json"
        request_file.write_text(json.dumps(self.request))
        process = subprocess.run([sys.executable, ROOT / "scripts/ai-music-runner.py", "--request", request_file],
                                 capture_output=True, text=True, timeout=15)
        self.assertEqual(process.returncode, 1)
        events = [json.loads(line) for line in process.stdout.splitlines()]
        self.assertEqual(events[-1]["stage"], "failed")
        self.assertIn("模型文件缺失", events[-1]["error"])
        self.assertFalse(Path(self.request["outputPath"]).exists())

    def test_events_are_serializable_and_flushed_to_protocol_stream(self):
        stream = io.StringIO()
        with patch.object(runner, "EVENT_STREAM", stream):
            runner.emit("generating", progress=0.5, detail="正在生成")
        self.assertEqual(json.loads(stream.getvalue())["progress"], 0.5)


class MusicCatalogTests(unittest.TestCase):
    def test_both_models_are_pinned_and_share_only_identical_components(self):
        catalog = json.loads((ROOT / "src-tauri/resources/ai-music-models.json").read_text())
        self.assertEqual(catalog["schemaVersion"], 1)
        models = catalog["models"]
        self.assertEqual({m["id"] for m in models}, set(runner.MODEL_VARIANTS))
        shared = {}
        for model in models:
            self.assertEqual(model["runtimeId"], "ai-generation-v1")
            self.assertEqual(model["license"]["name"], "MIT")
            self.assertGreater(sum(f["size"] for f in model["files"]), 6_000_000_000)
            self.assertEqual(len({f["path"] for f in model["files"]}), len(model["files"]))
            for file in model["files"]:
                self.assertRegex(file["sha256"], r"^[0-9a-f]{64}$")
                self.assertGreater(file["size"], 0)
                self.assertFalse(Path(file["path"]).is_absolute())
                self.assertNotIn("..", Path(file["path"]).parts)
                self.assertFalse(file["path"].endswith(".py"))
                self.assertNotIn("lm-1.7B", file["path"])
                for url in file["urls"]:
                    self.assertRegex(url, r"^https://[^/]+/ACE-Step/[^/]+/resolve/[a-f0-9]{40}/")
                if file["path"].startswith(("vae/", "Qwen3-Embedding-0.6B/")):
                    previous = shared.setdefault(file["path"], file)
                    self.assertEqual(previous, file)


if __name__ == "__main__":
    unittest.main()
