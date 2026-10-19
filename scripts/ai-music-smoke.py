#!/usr/bin/env python3
"""Run one real, offline, CPU music generation using a verified CI runtime.

This opt-in probe downloads model weights only onto its explicitly supplied work
directory. It checks inference compatibility and output structure, not musical
quality, GPU performance or consumer-device latency.
"""
from __future__ import annotations

import argparse
import array
import datetime as dt
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import time
import urllib.request
import wave

ROOT = Path(__file__).resolve().parent.parent
GIB = 1024**3
MODEL_ID = "ace-step-1.5-turbo"


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as source:
        while data := source.read(4 * 1024**2):
            result.update(data)
    return result.hexdigest()


def relative(value: str) -> Path:
    if (not isinstance(value, str) or not value or "\\" in value or ":" in value
            or "\0" in value or Path(value).is_absolute() or any(x in ("", ".", "..") for x in value.split("/"))):
        raise ValueError("Invalid relative artifact path")
    return Path(value)


def valid_file(path: Path, spec: dict) -> bool:
    return path.is_file() and path.stat().st_size == spec["size"] and digest(path) == spec["sha256"]


def validate_runtime_metadata(item: dict, source_commit: str) -> None:
    if not re.fullmatch(r"[a-f0-9]{40}", source_commit):
        raise ValueError("Expected an exact runtime source commit")
    if (item.get("id") != "ai-generation-v1" or item.get("version") != 1
            or item.get("platform") != "linux-x64" or item.get("sourceCommit") != source_commit
            or item.get("validated") is not True or item.get("validation", {}).get("imports") is not True
            or item.get("validation", {}).get("cpuCompute") is not True):
        raise ValueError("Runtime does not match the requested successful Linux build")
    for field in ("sha256", "manifestSha256"):
        if not re.fullmatch(r"[a-f0-9]{64}", item.get(field, "")):
            raise ValueError("Missing runtime integrity proof")
    if not 0 < item.get("size", 0) <= 8 * GIB or not 0 < item.get("unpackedSize", 0) <= 25 * GIB:
        raise ValueError("Unexpected runtime size")
    for part in item.get("parts") or [item]:
        name = str(relative(part["filename"]))
        if not re.fullmatch(r"ai-runtime-v1-linux-x64\.zip(?:\.part[0-9]+)?", name):
            raise ValueError("Unexpected runtime artifact name")
        if not 0 < part.get("size", 0) <= item["size"] or not re.fullmatch(r"[a-f0-9]{64}", part.get("sha256", "")):
            raise ValueError("Invalid runtime part proof")
    relative(item["executable"])


def assemble_runtime(artifacts: Path, work: Path, item: dict) -> Path:
    parts = item.get("parts") or [item]
    if len({part["filename"] for part in parts}) != len(parts):
        raise ValueError("Duplicate runtime parts")
    for part in parts:
        if not valid_file(artifacts / relative(part["filename"]), part):
            raise ValueError(f"Runtime part checksum mismatch: {part['filename']}")
    if not item.get("parts"):
        return artifacts / relative(item["filename"])
    archive = work / "runtime.zip"
    with archive.open("wb") as destination:
        for part in parts:
            with (artifacts / part["filename"]).open("rb") as source:
                shutil.copyfileobj(source, destination, 4 * 1024**2)
    if not valid_file(archive, item):
        raise ValueError("Combined runtime checksum mismatch")
    return archive


def download_file(spec: dict, destination: Path) -> None:
    if not 0 < spec.get("size", 0) <= 8 * GIB or not re.fullmatch(r"[a-f0-9]{64}", spec.get("sha256", "")):
        raise ValueError("Invalid model file proof")
    if valid_file(destination, spec):
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_name(destination.name + ".part")
    errors = []
    for url in spec["urls"]:
        if not url.startswith("https://"):
            raise ValueError("Model downloads must use HTTPS")
        for _attempt in range(2):
            try:
                offset = partial.stat().st_size if partial.exists() else 0
                if offset >= spec["size"]:
                    if offset == spec["size"] and digest(partial) == spec["sha256"]:
                        partial.replace(destination)
                        return
                    partial.unlink()
                    offset = 0
                headers = {"User-Agent": "Open-Media-model-verification/1", "Accept-Encoding": "identity"}
                if offset:
                    headers["Range"] = f"bytes={offset}-"
                with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60) as response:
                    if not response.url.startswith("https://"):
                        raise ValueError("Download redirected away from HTTPS")
                    status = response.status
                    if status == 206:
                        content_range = response.headers.get("Content-Range", "")
                        if not re.fullmatch(fr"bytes {offset}-[0-9]+/{spec['size']}", content_range):
                            raise ValueError("Unexpected download range")
                    elif status == 200:
                        offset = 0
                    else:
                        raise ValueError("Unexpected download response")
                    total, last_report = offset, time.monotonic()
                    with partial.open("ab" if offset else "wb") as output:
                        while data := response.read(4 * 1024**2):
                            total += len(data)
                            if total > spec["size"]:
                                raise ValueError("Model response exceeds catalog size")
                            output.write(data)
                            if time.monotonic() - last_report >= 20:
                                print(f"Downloading {spec['path']}: {total}/{spec['size']} bytes", flush=True)
                                last_report = time.monotonic()
                if not valid_file(partial, spec):
                    raise ValueError("Model size or checksum mismatch")
                partial.replace(destination)
                return
            except Exception as error:
                # Signed redirect query strings must not enter public CI logs.
                errors.append(type(error).__name__)
                print(f"Retrying {spec['path']}: {type(error).__name__}", flush=True)
    raise RuntimeError(f"Could not verify {spec['path']} ({', '.join(errors)})")


def validate_audio(path: Path, ffprobe: str = "ffprobe") -> dict:
    process = subprocess.run([ffprobe, "-v", "error", "-show_format", "-show_streams", "-of", "json", str(path)],
                             capture_output=True, text=True, check=True, timeout=30)
    probe = json.loads(process.stdout)
    streams = probe.get("streams", [])
    duration = float(probe.get("format", {}).get("duration", "nan"))
    if (len(streams) != 1 or streams[0].get("codec_name") != "pcm_s16le"
            or int(streams[0].get("sample_rate", 0)) != 48000
            or streams[0].get("channels") not in (1, 2) or not 9.5 <= duration <= 10.5):
        raise ValueError("Generated WAV format or duration differs from the requested ten seconds")
    samples = array.array("h")
    with wave.open(str(path), "rb") as source:
        if source.getsampwidth() != 2:
            raise ValueError("Expected PCM16 audio")
        samples.frombytes(source.readframes(source.getnframes()))
    if sys.byteorder != "little":
        samples.byteswap()
    if not samples:
        raise ValueError("Generated audio is empty")
    peak = max(abs(value) for value in samples) / 32768
    rms = math.sqrt(sum(value * value for value in samples) / len(samples)) / 32768
    nonzero = sum(value != 0 for value in samples)
    if not math.isfinite(rms) or peak <= 0 or nonzero == 0:
        raise ValueError("Generated audio is silent or invalid")
    return {"ffprobe": probe, "samples": len(samples), "nonzeroSamples": nonzero, "peak": peak,
            "rms": rms, "sha256": digest(path), "subjectiveQualityEvaluated": False}


def run_inference(executable: Path, request: Path, evidence: Path, timeout: int) -> None:
    wrapper = evidence / "offline-entry.py"
    wrapper.write_text(
        "import runpy, socket, sys\n"
        "def blocked(*args, **kwargs):\n"
        "    raise RuntimeError('Network access is disabled for the real model probe')\n"
        "socket.socket.connect = blocked\n"
        "socket.socket.connect_ex = blocked\n"
        "socket.create_connection = blocked\n"
        "socket.getaddrinfo = blocked\n"
        "adapter, request = sys.argv[1:]\n"
        "sys.argv = [adapter, '--request', request]\n"
        "runpy.run_path(adapter, run_name='__main__')\n", encoding="utf-8")
    env = dict(os.environ, HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_DATASETS_OFFLINE="1",
               HF_HUB_DISABLE_TELEMETRY="1", TOKENIZERS_PARALLELISM="false",
               OMP_NUM_THREADS=str(min(4, os.cpu_count() or 1)), MKL_NUM_THREADS=str(min(4, os.cpu_count() or 1)))
    command = ["/usr/bin/time", "-v", "-o", str(evidence / "resource-usage.txt"), str(executable), "-I", "-B", "-u",
               str(wrapper), str(ROOT / "scripts/ai-music-runner.py"), str(request)]
    started = time.monotonic()
    with (evidence / "events.jsonl").open("w", encoding="utf-8") as out, (evidence / "inference.log").open("w", encoding="utf-8") as err, (evidence / "memory-during.jsonl").open("w", encoding="utf-8") as memory:
        process = subprocess.Popen(command, stdout=out, stderr=err, env=env, start_new_session=True)
        try:
            while process.poll() is None:
                try:
                    process.wait(timeout=min(30, max(0.1, timeout - (time.monotonic() - started))))
                except subprocess.TimeoutExpired:
                    print(f"Real CPU generation elapsed: {int(time.monotonic() - started)} seconds", flush=True)
                    memory.write(json.dumps({"elapsedSeconds": round(time.monotonic() - started, 2),
                                             "memoryInfo": Path("/proc/meminfo").read_text()}) + "\n")
                    memory.flush()
                    if time.monotonic() - started >= timeout:
                        raise TimeoutError("Real CPU generation exceeded the configured time limit")
            if process.returncode != 0:
                raise RuntimeError(f"Production adapter failed with exit status {process.returncode}; see inference.log/events.jsonl")
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
    events = []
    for line in (evidence / "events.jsonl").read_text(encoding="utf-8").splitlines():
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    if not any(item.get("stage") == "completed" and item.get("device") == "cpu" for item in events):
        raise ValueError("Adapter did not report a completed CPU generation")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-artifacts", type=Path, required=True)
    parser.add_argument("--runtime-source-commit", required=True)
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--timeout", type=int, default=5400)
    args = parser.parse_args()
    if not 60 <= args.timeout <= 7200:
        raise ValueError("Generation timeout must be 60–7200 seconds")
    args.work, args.evidence = args.work.resolve(), args.evidence.resolve()
    args.work.mkdir(parents=True, exist_ok=True)
    args.evidence.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    report = {"schemaVersion": 1, "modelId": MODEL_ID, "device": "cpu", "seconds": 10, "steps": 8,
              "actualModelGeneration": "not-run", "subjectiveQualityEvaluated": False, "gpuTested": False,
              "startedAt": dt.datetime.now(dt.timezone.utc).isoformat(), "sourceCommit": os.environ.get("GITHUB_SHA"),
              "runtimeSourceCommit": args.runtime_source_commit}
    try:
        item = json.loads((args.runtime_artifacts / "runtime-metadata.json").read_text(encoding="utf-8"))
        validate_runtime_metadata(item, args.runtime_source_commit)
        catalog_path = ROOT / "src-tauri/resources/ai-music-models.json"
        model = next(model for model in json.loads(catalog_path.read_text(encoding="utf-8"))["models"] if model["id"] == MODEL_ID)
        if len({file["path"] for file in model["files"]}) != len(model["files"]):
            raise ValueError("Duplicate model file paths")
        model_size = sum(file["size"] for file in model["files"])
        required_free = item["unpackedSize"] + (item["size"] if item.get("parts") else 0) + model_size + 3 * GIB
        free = shutil.disk_usage(args.work).free
        memory_info = Path("/proc/meminfo").read_text()
        memory = {key: int(value) * 1024 for key, value in re.findall(r"^(MemTotal|SwapTotal):\s+(\d+) kB", memory_info, re.M)}
        report["resources"] = {"freeDiskBytes": free, "requiredFreeDiskBytes": required_free,
                               "memoryInfo": memory_info, "modelBytes": model_size}
        write_json(args.evidence / "runtime-metadata.json", item)
        write_json(args.evidence / "model-manifest.json", model)
        report["adapterSha256"] = digest(ROOT / "scripts/ai-music-runner.py")
        shutil.copy2(ROOT / "scripts/ai-music-runner.py", args.evidence / "production-adapter.py")
        report["catalogSha256"] = digest(catalog_path)
        if free < required_free:
            raise RuntimeError("Insufficient free disk for verified runtime, model weights and working space")
        if memory.get("MemTotal", 0) < 13 * GIB or sum(memory.values()) < 21 * GIB:
            raise RuntimeError("CPU probe requires at least 13 GiB physical memory and 21 GiB combined memory/swap")
        archive = assemble_runtime(args.runtime_artifacts, args.work, item)
        spec = importlib.util.spec_from_file_location("portable_runtime", ROOT / "scripts/optional-speech-runtime-build.py")
        portable = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(portable)
        runtime = args.work / "runtime"
        if runtime.exists():
            raise ValueError("Use a fresh work directory for the runtime extraction")
        print("Verifying and extracting the exact runtime artifact", flush=True)
        portable.verify_archive(archive, runtime, item)
        model_root = args.work / "models" / MODEL_ID / model["version"]
        for file in model["files"]:
            path = model_root / relative(file["path"])
            print(f"Verifying model file: {file['path']}", flush=True)
            download_file(file, path)
        request = {"modelId": MODEL_ID, "modelRoot": str(model_root), "outputPath": str(args.evidence / "generated.wav"),
                   "mode": "text-to-music", "prompt": "Warm cinematic instrumental, piano and gentle strings, a clear beginning and gentle ending, no vocals.",
                   "lyrics": "", "instrumental": True, "seconds": 10, "steps": 8, "seed": 42,
                   "guidance": 1, "device": "cpu", "memoryMode": "balanced"}
        request_path = args.evidence / "request.json"
        write_json(request_path, request)
        report["actualModelGeneration"] = "running"
        write_json(args.evidence / "report.json", report)
        run_inference(runtime / relative(item["executable"]), request_path, args.evidence, args.timeout)
        audio = validate_audio(args.evidence / "generated.wav")
        write_json(args.evidence / "audio-validation.json", audio)
        report["runtimeIntegrity"] = portable.verify_tree(runtime, item)
        report["actualModelGeneration"] = "passed"
        report["audio"] = {key: value for key, value in audio.items() if key != "ffprobe"}
        print("Real ten-second CPU generation passed output and runtime-integrity checks", flush=True)
    except Exception as error:
        report["actualModelGeneration"] = "timeout" if isinstance(error, TimeoutError) else "failed"
        report["error"] = str(error)
        raise
    finally:
        report["elapsedSeconds"] = round(time.monotonic() - started, 3)
        write_json(args.evidence / "report.json", report)


if __name__ == "__main__":
    main()
