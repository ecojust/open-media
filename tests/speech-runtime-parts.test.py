#!/usr/bin/env python3
"""Verify split downloads using bounded local bytes, never substitute model inference."""
import importlib.util
import io
import json
import subprocess
import sys
from pathlib import Path
import tempfile
import unittest
import zipfile
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


builder = load("runtime_builder", "optional-speech-runtime-build.py")
validator = load("cuda_artifacts", "verify-cuda-runtime-artifact.py")


class SplitRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="runtime-parts-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.archive = self.root / "speech-runtime-python-cuda-v1-windows-x64.zip"
        self.data = bytes(range(32)) + b"portable runtime evidence"
        self.archive.write_bytes(self.data)
        self.metadata = dict(filename=self.archive.name, size=len(self.data), sha256=builder.sha256(self.archive))

    def split(self):
        return builder.split_archive(self.archive, self.metadata, "speech-runtime-cuda-v1", part_bytes=16)

    def test_parts_preserve_complete_bytes_and_allow_reconstruction(self):
        metadata = self.split()
        self.assertEqual(sum(item["size"] for item in metadata["parts"]), len(self.data))
        self.assertEqual(b"".join((self.root / item["filename"]).read_bytes() for item in metadata["parts"]), self.data)
        validator.verify_parts(self.root, metadata)
        payloads = {item["url"]: (self.root / item["filename"]).read_bytes() for item in metadata["parts"]}
        destination = self.root / "download/runtime.zip"
        with patch.object(builder.urllib.request, "urlopen", side_effect=lambda url, **_: io.BytesIO(payloads[url])):
            builder.download(metadata, destination)
        self.assertEqual(destination.read_bytes(), self.data)
        self.assertEqual(list(destination.parent.iterdir()), [destination])

    def test_changed_part_is_rejected_before_release(self):
        metadata = self.split()
        (self.root / metadata["parts"][0]["filename"]).write_bytes(b"corrupt")
        with self.assertRaisesRegex(ValueError, "SHA-256"):
            validator.verify_parts(self.root, metadata)

    def test_reordered_parts_are_rejected(self):
        metadata = self.split()
        metadata["parts"].reverse()
        with self.assertRaisesRegex(ValueError, "ordered"):
            validator.verify_parts(self.root, metadata)

    def test_missing_and_oversized_parts_are_rejected(self):
        metadata = self.split()
        for value in ([], metadata["parts"][:-1], [dict(metadata["parts"][0], size=builder.RELEASE_PART_BYTES + 1)]):
            bad = dict(metadata, parts=value)
            with self.subTest(parts=len(value)), self.assertRaises(ValueError):
                builder.download(bad, self.root / "missing.zip")

    def test_invalid_source_hash_never_produces_parts(self):
        for patch_value in ({"sha256": "0" * 64}, {"size": 0}):
            with self.subTest(patch=patch_value), self.assertRaises(ValueError):
                builder.split_archive(self.archive, dict(self.metadata, **patch_value), "speech-runtime-cuda-v1")
        self.assertEqual(list(self.root.glob("*.part*")), [])

    def test_total_hash_must_match_even_when_individual_parts_match(self):
        metadata = self.split()
        metadata["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "Complete runtime SHA-256"):
            validator.verify_parts(self.root, metadata)
        payloads = {item["url"]: (self.root / item["filename"]).read_bytes() for item in metadata["parts"]}
        destination = self.root / "download.zip"
        with patch.object(builder.urllib.request, "urlopen", side_effect=lambda url, **_: io.BytesIO(payloads[url])):
            with self.assertRaisesRegex(ValueError, "Combined runtime"):
                builder.download(metadata, destination)
        self.assertFalse(destination.exists())
        self.assertFalse(destination.with_name(destination.name + ".part").exists())

    def test_changed_download_part_is_rejected_and_removed(self):
        metadata = self.split()
        destination = self.root / "bad-download.zip"
        with patch.object(builder.urllib.request, "urlopen", side_effect=lambda *args, **kwargs: io.BytesIO(b"invalid")), patch.object(builder.time, "sleep"):
            with self.assertRaises((ValueError, OSError)):
                builder.download(metadata, destination)
        self.assertFalse(destination.exists())
        self.assertFalse(destination.with_name(destination.name + ".part").exists())

    def test_untrusted_split_paths_and_release_coordinates_are_rejected(self):
        for tag in ("../../other", "release/name", ""):
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                builder.split_archive(self.archive, self.metadata, tag)
        metadata = self.split()
        metadata["parts"][0]["url"] = metadata["parts"][0]["url"].replace("speech-runtime-cuda-v1", "speech-runtime-v1")
        with self.assertRaisesRegex(ValueError, "ordered"):
            validator.verify_parts(self.root, metadata)

    def test_new_cuda_components_preserve_original_runtime_identity(self):
        old = json.loads((ROOT / "scripts/optional-speech-runtime.lock.json").read_text(encoding="utf-8"))
        new = json.loads((ROOT / "scripts/optional-speech-runtime-cuda.lock.json").read_text(encoding="utf-8"))
        self.assertEqual(old["id"], "python-cpu-v1")
        self.assertEqual(old["platforms"]["windows-x64"]["torch"], "2.9.1+cpu")
        self.assertEqual(new["id"], "python-cuda-v1")
        self.assertEqual(new["releaseTag"], "speech-runtime-cuda-v1")
        self.assertEqual(set(new["platforms"]), {"windows-x64"})
        spec = new["platforms"]["windows-x64"]
        self.assertEqual(spec["torch"], "2.9.1+cu128")
        self.assertEqual(spec["cudaVersion"], "12.8")
        for key in ("torchWheel", "torchaudioWheel"):
            self.assertRegex(spec[key]["sha256"], r"^[0-9a-f]{64}$")
            self.assertTrue(spec[key]["url"].startswith("https://download-r2.pytorch.org/whl/cu128/"))
        self.assertGreater(spec["torchWheel"]["size"], 2 * 1024**3)

    def test_streamed_archive_verification_checks_every_member_before_relocation(self):
        runtime = self.root / "runtime"
        (runtime / "runner").mkdir(parents=True)
        (runtime / "python").mkdir()
        (runtime / "runner/tts.py").write_text("original runner", encoding="utf-8")
        (runtime / "python/python.exe").write_bytes(b"interpreter fixture")
        archive = self.root / "portable.zip"
        metadata = builder.package(runtime, archive, {"executable": "python/python.exe"}, "windows-x64")
        builder.verify_archive_payload(archive, metadata)
        with zipfile.ZipFile(archive) as source:
            files = {name: source.read(name) for name in source.namelist()}
        files["runner/tts.py"] = b"modified runner"
        with zipfile.ZipFile(archive, "w") as target:
            for name, data in files.items():
                target.writestr(name, data)
        metadata.update(size=archive.stat().st_size, sha256=builder.sha256(archive))
        with self.assertRaisesRegex(ValueError, "member size or SHA-256"):
            builder.verify_archive_payload(archive, metadata)

    def test_release_rejects_missing_voice_false_gpu_claims_and_old_source(self):
        metadata = dict(self.split(), id="python-cuda-v1", version=1, platform="windows-x64", sourceCommit="a" * 40,
                        validated=True, validatedModels=["f5-v1-base-fp32", "qwen3-tts-1.7b-serena"],
                        productionValidated=True, productionVoiceIds=list(validator.VOICES), gpuInferenceValidated=False,
                        manifestSha256="b" * 64,
                        cudaProbe=dict(cudaVersion="12.8", torchVersion="2.9.1+cu128", cpuTensorProbePassed=True,
                                       cudaAvailable=False, cudaDeviceCount=0))
        voices = [dict(voiceId=voice, status="passed", completionVerified=True, requestedDevice="auto", backend="cpu",
                       gpuInferenceVerified=False, productionPath="SpeechRuntime::command + generate_wave", eosVerified=True,
                       events=["stage=device,device=cpu", "stage=complete"],
                       audio=dict(finite=True,sampleRate=24000,channels=1,sha256="c"*64,bytes=192044,
                                  durationSeconds=4,peak=1.2,rms=.1)) for voice in validator.VOICES]
        summary = dict(sourceCommit="a" * 40, status="passed", platform="windows-x64", voices=voices, gpuInferenceVerified=False)
        builder.write_json(self.root / "post-application-integrity.json", dict(unchanged=True, manifestSha256="b" * 64))

        def verify(value, extra=()):
            builder.write_json(self.root / "application-validation.json", value)
            metadata["applicationValidationSha256"] = builder.sha256(self.root / "application-validation.json")
            builder.write_json(self.root / "runtime-metadata.json", metadata)
            return subprocess.run([sys.executable, str(ROOT / "scripts/verify-cuda-runtime-artifact.py"),
                                   "--phase", "release", "--directory", str(self.root), "--source-commit", "a" * 40, *extra],
                                  capture_output=True, text=True, timeout=10)

        self.assertEqual(verify(summary).returncode, 0)
        self.assertNotEqual(verify(summary, ("--require-cuda",)).returncode, 0)
        self.assertNotEqual(verify(dict(summary, sourceCommit="d" * 40)).returncode, 0)
        self.assertNotEqual(verify(dict(summary, voices=voices[:-1])).returncode, 0)
        self.assertNotEqual(verify(dict(summary, gpuInferenceVerified=True)).returncode, 0)
        self.assertNotEqual(verify(dict(summary, voices=[dict(voices[0], audio=dict(voices[0]["audio"], rms=0)), *voices[1:]])).returncode, 0)


if __name__ == "__main__":
    unittest.main()
