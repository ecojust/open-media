#!/usr/bin/env python3
"""Small integrity and output checks for the optional real-weight CI probe."""
import array
import hashlib
import importlib.util
import io
import json
import math
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch
import wave


SPEC = importlib.util.spec_from_file_location("music_smoke", Path(__file__).with_name("ai-music-smoke.py"))
smoke = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(smoke)


class Response(io.BytesIO):
    def __init__(self, data, status=200, content_range=""):
        super().__init__(data)
        self.status = status
        self.url = "https://example.invalid/verified-model"
        self.headers = {"Content-Range": content_range}


class SmokeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def spec(self, data):
        return dict(path="model.bin", size=len(data), sha256=hashlib.sha256(data).hexdigest(),
                    urls=["https://example.invalid/weights"])

    def test_runtime_requires_matching_commit_and_successful_validation(self):
        item = dict(id="ai-generation-v1", version=1, platform="linux-x64", sourceCommit="a" * 40,
                    validated=True, validation=dict(imports=True, cpuCompute=True), sha256="b" * 64,
                    manifestSha256="c" * 64, size=100, unpackedSize=200, executable="python/bin/python3",
                    filename="ai-runtime-v1-linux-x64.zip")
        smoke.validate_runtime_metadata(item, "a" * 40)
        for replacement in [dict(sourceCommit="d" * 40), dict(validated=False), dict(platform="windows-x64"),
                            dict(validation=dict(imports=True)), dict(filename="../runtime.zip"), dict(sha256="bad")]:
            with self.subTest(replacement=replacement), self.assertRaises(ValueError):
                smoke.validate_runtime_metadata({**item, **replacement}, "a" * 40)

    def test_split_artifacts_require_both_part_and_combined_hashes(self):
        parts = []
        for index, data in enumerate((b"first", b"second"), 1):
            name = f"ai-runtime-v1-linux-x64.zip.part{index:03d}"
            (self.root / name).write_bytes(data)
            parts.append({**self.spec(data), "filename": name})
        item = {**self.spec(b"firstsecond"), "parts": parts}
        archive = smoke.assemble_runtime(self.root, self.root, item)
        self.assertEqual(archive.read_bytes(), b"firstsecond")
        with self.assertRaisesRegex(ValueError, "Combined"):
            smoke.assemble_runtime(self.root, self.root, {**item, "sha256": "0" * 64})
        (self.root / parts[0]["filename"]).write_bytes(b"other")
        with self.assertRaisesRegex(ValueError, "part checksum"):
            smoke.assemble_runtime(self.root, self.root, item)

    def test_download_resumes_only_an_exact_content_range(self):
        data = b"verified model payload"
        path = self.root / "model.bin"
        path.with_suffix(".bin.part").write_bytes(data[:8])
        with patch.object(smoke.urllib.request, "urlopen", return_value=Response(data[8:], 206, f"bytes 8-{len(data)-1}/{len(data)}")) as request:
            smoke.download_file(self.spec(data), path)
            self.assertEqual(request.call_args.args[0].headers["Range"], "bytes=8-")
        self.assertEqual(path.read_bytes(), data)

    def test_download_restarts_when_server_ignores_range(self):
        data = b"the complete payload"
        path = self.root / "model.bin"
        path.with_suffix(".bin.part").write_bytes(b"old partial")
        with patch.object(smoke.urllib.request, "urlopen", return_value=Response(data)):
            smoke.download_file(self.spec(data), path)
        self.assertEqual(path.read_bytes(), data)

    def test_wrong_hash_never_creates_an_installed_file(self):
        path = self.root / "model.bin"
        with patch.object(smoke.urllib.request, "urlopen", side_effect=lambda *args, **kwargs: Response(b"bad")):
            with self.assertRaisesRegex(RuntimeError, "Could not verify"):
                smoke.download_file(self.spec(b"yes"), path)
        self.assertFalse(path.exists())

    def write_wave(self, name, seconds, silent=False):
        path = self.root / name
        samples = array.array("h", (0 if silent else int(8000 * math.sin(2 * math.pi * 440 * index / 48000))
                                   for index in range(int(48000 * seconds))))
        if sys.byteorder != "little":
            samples.byteswap()
        with wave.open(str(path), "wb") as target:
            target.setnchannels(1)
            target.setsampwidth(2)
            target.setframerate(48000)
            target.writeframes(samples.tobytes())
        return path

    @unittest.skipUnless(shutil.which("ffprobe"), "Audio validation requires ffprobe")
    def test_real_wav_decodes_and_silence_or_wrong_duration_is_rejected(self):
        report = smoke.validate_audio(self.write_wave("tone.wav", 10))
        self.assertGreater(report["rms"], 0)
        self.assertFalse(report["subjectiveQualityEvaluated"])
        for name, duration, silent in [("silent.wav", 10, True), ("short.wav", 1, False)]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                smoke.validate_audio(self.write_wave(name, duration, silent))

    @unittest.skipUnless(Path("/usr/bin/time").exists(), "Linux process/resource probe")
    def test_subprocess_is_offline_and_requires_completed_cpu_event(self):
        scripts = self.root / "scripts"
        scripts.mkdir()
        (scripts / "ai-music-runner.py").write_text(
            "import socket, json\n"
            "try:\n"
            "    socket.create_connection(('example.invalid', 443))\n"
            "    raise AssertionError('network unexpectedly permitted')\n"
            "except RuntimeError as error:\n"
            "    assert 'Network access is disabled' in str(error)\n"
            "print(json.dumps({'stage':'completed','device':'cpu'}))\n")
        with patch.object(smoke, "ROOT", self.root):
            smoke.run_inference(Path(sys.executable), self.root / "request.json", self.root, 5)
        self.assertIn("Maximum resident set size", (self.root / "resource-usage.txt").read_text())
        (scripts / "ai-music-runner.py").write_text("print('{}')\n")
        with patch.object(smoke, "ROOT", self.root), self.assertRaisesRegex(ValueError, "completed CPU"):
            smoke.run_inference(Path(sys.executable), self.root / "request.json", self.root, 5)

    @unittest.skipUnless(Path("/usr/bin/time").exists(), "Linux process/resource probe")
    def test_inference_timeout_terminates_the_process(self):
        scripts = self.root / "scripts"
        scripts.mkdir()
        (scripts / "ai-music-runner.py").write_text("import time\ntime.sleep(60)\n")
        with patch.object(smoke, "ROOT", self.root), self.assertRaises(TimeoutError):
            smoke.run_inference(Path(sys.executable), self.root / "request.json", self.root, 0.2)


if __name__ == "__main__":
    unittest.main()
