#!/usr/bin/env python3
"""Bind a split acceleration runtime to real application inference evidence."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
VOICES = ("f5_zh_female", "f5_zh_male", "qwen3_serena", "qwen3_uncle_fu")


def module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def verify_parts(folder: Path, metadata: dict) -> None:
    integrity = module("runtime_integrity", ROOT / "scripts/optional-speech-runtime-build.py")
    parts = metadata.get("parts", [])
    if not 1 <= len(parts) <= 64 or sum(part["size"] for part in parts) != metadata["size"]:
        raise ValueError("The complete split runtime inventory is required")
    digest, names = hashlib.sha256(), set()
    for index, part in enumerate(parts, 1):
        filename = metadata["filename"] + f".part{index:03d}"
        if (part["filename"] != filename or filename in names or
                part["url"] != f"https://github.com/ecojust/open-media/releases/download/speech-runtime-cuda-v1/{filename}" or
                not 0 < part["size"] <= integrity.RELEASE_PART_BYTES):
            raise ValueError("Invalid ordered runtime part")
        names.add(filename)
        path = folder / integrity.relative(filename)
        if not integrity.checked_file(path, part["size"], part["sha256"]):
            raise ValueError("Runtime part size or SHA-256 changed")
        with path.open("rb") as source:
            while data := source.read(4 * 1024**2):
                digest.update(data)
    if digest.hexdigest() != metadata["sha256"]:
        raise ValueError("Complete runtime SHA-256 differs from its ordered parts")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--require-cuda", action="store_true")
    parser.add_argument("--phase", choices=("application", "release"), required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[a-f0-9]{40}", args.source_commit):
        raise ValueError("A complete reviewed source commit is required")
    metadata_path = args.directory / "runtime-metadata.json"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    if (metadata.get("id") != "python-cuda-v1" or metadata.get("version") != 1 or
            metadata.get("platform") != "windows-x64" or metadata.get("sourceCommit") != args.source_commit or
            metadata.get("validated") is not True or set(metadata.get("validatedModels", [])) != {"f5-v1-base-fp32", "qwen3-tts-1.7b-serena"} or
            metadata.get("filename") != "speech-runtime-python-cuda-v1-windows-x64.zip"):
        raise ValueError("Runtime identity, source or real model verification differs")
    probe = metadata.get("cudaProbe", {})
    if probe.get("cudaVersion") != "12.8" or probe.get("torchVersion") != "2.9.1+cu128" or probe.get("cpuTensorProbePassed") is not True:
        raise ValueError("The runtime was not built with the expected acceleration support")
    if args.phase == "application":
        verifier = module("installed_speech_verifier", ROOT / "scripts/verify-installed-speech.py")
        available = {"python": {"cudaAvailable": probe["cudaAvailable"], "mpsAvailable": False}}
        voices = [verifier.collect_voice(args.directory / "validation/application", voice, available) for voice in VOICES]
        if args.require_cuda and any(voice["backend"] != "cuda" for voice in voices):
            raise ValueError("Every production voice must really execute on CUDA in this validation")
        summary = dict(schema=1, sourceCommit=args.source_commit, platform="windows-x64", status="passed",
                       requestedDevice="auto", voices=voices,
                       gpuInferenceVerified=all(voice["backend"] == "cuda" for voice in voices),
                       hardware=probe)
        verifier.integrity.write_json(args.directory / "application-validation.json", summary)
        metadata.update(productionValidated=True, productionVoiceIds=list(VOICES),
                        gpuInferenceValidated=summary["gpuInferenceVerified"],
                        applicationValidationSha256=verifier.integrity.sha256(args.directory / "application-validation.json"))
        verifier.integrity.write_json(metadata_path, metadata)
    else:
        summary_path = args.directory / "application-validation.json"
        raw = summary_path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != metadata.get("applicationValidationSha256"):
            raise ValueError("Production inference evidence changed")
        summary = json.loads(raw)
        if (summary.get("sourceCommit") != args.source_commit or summary.get("status") != "passed" or
                summary.get("platform") != "windows-x64" or metadata.get("productionValidated") is not True or
                metadata.get("productionVoiceIds") != list(VOICES) or
                [voice.get("voiceId") for voice in summary.get("voices", [])] != list(VOICES) or
                any(voice.get("status") != "passed" or voice.get("completionVerified") is not True for voice in summary["voices"])):
            raise ValueError("The four real production voices have not all passed")
        actual_gpu = all(voice.get("backend") == "cuda" for voice in summary["voices"])
        if any(voice.get("backend") == "cuda" for voice in summary["voices"]) and (probe.get("cudaAvailable") is not True or probe.get("cudaDeviceCount", 0) < 1):
            raise ValueError("CUDA execution is not backed by the actual hardware probe")
        for voice in summary["voices"]:
            audio = voice.get("audio", {})
            events = voice.get("events", [])
            device_events = [event for event in events if isinstance(event, str) and event.startswith("stage=device,")]
            device = verifier_field(device_events[-1], "device") if device_events else None
            if (voice.get("backend") not in ("cpu", "cuda") or device != voice["backend"] or
                    voice.get("requestedDevice") != "auto" or
                    voice.get("gpuInferenceVerified") is not (voice["backend"] == "cuda") or
                    not events or not re.match(r"^stage=complete(?:,|$)", events[-1]) or
                    voice.get("productionPath") != "SpeechRuntime::command + generate_wave" or
                    (voice["voiceId"].startswith("qwen3_") and voice.get("eosVerified") is not True)):
                raise ValueError("Actual production device or normal completion evidence is missing")
            if (audio.get("finite") is not True or audio.get("sampleRate") != 24000 or audio.get("channels") != 1 or
                    not re.fullmatch(r"[a-f0-9]{64}", audio.get("sha256", "")) or
                    not isinstance(audio.get("bytes"), int) or audio["bytes"] <= 44 or
                    any(not isinstance(audio.get(key), (int, float)) or not math.isfinite(audio[key]) for key in ("durationSeconds", "peak", "rms")) or
                    not .25 <= audio["durationSeconds"] <= 120 or not audio["peak"] > .001 or not 0.00001 < audio["rms"] <= audio["peak"]):
                raise ValueError("Finite non-silent generated audio evidence is missing")
        if metadata.get("gpuInferenceValidated") != actual_gpu or summary.get("gpuInferenceVerified") != actual_gpu:
            raise ValueError("GPU verification does not match actual production execution")
        if args.require_cuda and not actual_gpu:
            raise ValueError("This release requires real GPU synthesis evidence")
        verify_parts(args.directory, metadata)
        proof = json.loads((args.directory / "post-application-integrity.json").read_text(encoding="utf-8"))
        if proof.get("unchanged") is not True or proof.get("manifestSha256") != metadata["manifestSha256"]:
            raise ValueError("The runtime changed during application inference")
    print(json.dumps(dict(phase=args.phase, sourceCommit=args.source_commit,
                         gpuInferenceValidated=metadata.get("gpuInferenceValidated"), passed=True)))


def verifier_field(event: str, key: str):
    return dict(part.split("=", 1) for part in event.split(",") if "=" in part).get(key)


if __name__ == "__main__":
    main()
