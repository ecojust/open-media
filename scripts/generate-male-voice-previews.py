#!/usr/bin/env python3
"""Generate genuine male reference and auditions using the installed model paths.

No application build is performed. Model downloads require --download-qwen and
are checked against the application's pinned catalog before inference.
"""

import argparse
import array
import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "scripts/optional-speech-assets"
PREVIEWS = ROOT / "src/assets/voice-previews"
TEXT = "欢迎使用 Open Media。你可以录制屏幕、剪辑视频、编辑图片，还能生成配音，让创作更轻松。"
REFERENCE_TEXT = "清晨的阳光照进房间，翻开今天的计划，让每一个想法慢慢变成现实。"
MODEL_IDS = {"qwen3_uncle_fu": "qwen3-tts-1.7b-serena", "f5_zh_male": "f5-v1-base-fp32",
             "zipvoice_zh_male": "zipvoice-distill-fp32"}


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def verify(path, item):
    if not path.is_file() or path.stat().st_size != item["size"] or digest(path) != item["sha256"]:
        raise ValueError(f"Model integrity verification failed: {path}")


def prepare_qwen(model, destination, allow_download):
    for item in model["files"]:
        path = destination / item["path"]
        try:
            verify(path, item)
            continue
        except ValueError:
            pass
        path.parent.mkdir(parents=True, exist_ok=True)
        if item.get("embedded"):
            source = ASSETS / item["embedded"]
            verify(source, item)
            shutil.copyfile(source, path)
            continue
        if not allow_download:
            raise ValueError(f"Missing model resource; use --download-qwen: {path}")
        temporary = path.with_name(path.name + ".part")
        for url in [item["url"], *item.get("mirrors", [])]:
            try:
                print(f"Downloading {item['path']}", flush=True)
                started = last = time.monotonic()
                received = 0
                with urllib.request.urlopen(url, timeout=45) as response, temporary.open("wb") as output:
                    while chunk := response.read(4 * 1024 * 1024):
                        received += len(chunk)
                        if received > item["size"]:
                            raise ValueError("Download exceeds pinned file size")
                        output.write(chunk)
                        if time.monotonic() - last >= 10:
                            print(f"{item['path']}: {received}/{item['size']} bytes; "
                                  f"{time.monotonic() - started:.1f}s", flush=True)
                            last = time.monotonic()
                verify(temporary, item)
                temporary.replace(path)
                break
            except Exception as error:
                temporary.unlink(missing_ok=True)
                print(f"Source failed: {type(error).__name__}: {error}", flush=True)
        else:
            raise RuntimeError(f"All model sources failed: {item['path']}")


def inspect_audio(path):
    probe = json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
        "stream=sample_rate,channels", "-of", "json", str(path)]))["streams"][0]
    if probe != {"sample_rate": "24000", "channels": 1}:
        raise ValueError(f"Expected 24 kHz mono audio: {path}")
    data = subprocess.check_output(["ffmpeg", "-v", "error", "-i", str(path),
                                   "-f", "f32le", "-acodec", "pcm_f32le", "-"])
    samples = array.array("f", data)
    if sys.byteorder != "little":
        samples.byteswap()
    if not samples or not all(math.isfinite(value) for value in samples):
        raise ValueError("Empty or non-finite generated audio")
    rms = math.sqrt(sum(value * value for value in samples) / len(samples))
    if rms < 0.0001 or len(samples) < 2400:
        raise ValueError("Silent or truncated generated audio")
    return dict(sampleRate=24000, channels=1, durationSeconds=len(samples) / 24000,
                peak=max(abs(value) for value in samples), rms=rms)


def run(command, log):
    started = time.monotonic()
    print(f"Generating {log.parent.name}; progress log: {log}", flush=True)
    with log.open("w", encoding="utf-8") as output:
        result = subprocess.run([str(value) for value in command], stdout=output,
                                stderr=subprocess.STDOUT, timeout=1800, cwd=ROOT)
    if result.returncode:
        raise RuntimeError(f"Generation failed ({result.returncode}); see {log}")
    return time.monotonic() - started


def job_directory(args, name, text):
    job = args.work / name
    job.mkdir(parents=True, exist_ok=True)
    (job / "text.txt").write_text(text, encoding="utf-8")
    return job


def generate_python(args, voice, text, name):
    job = job_directory(args, name, text)
    shutil.copyfile(ROOT / "scripts/speech-voice-adapter.py", job / "speech-voice-adapter.py")
    shutil.copyfile(ROOT / "scripts/speech-device-runtime.py", job / "speech-device-runtime.py")
    if voice == "f5_zh_male":
        for filename in ("male-reference.wav", "male-reference.txt"):
            shutil.copyfile(ASSETS / filename, job / filename)
    config = args.f5_config if voice.startswith("f5_") else args.qwen_model / "runner-config.json"
    command = [args.python, "-I", "-B", job / "speech-voice-adapter.py",
               "--runtime-script", args.runtime_script, "--voice", voice,
               "--config", config, "--text-file", job / "text.txt",
               "--output-filename", job / "speech.wav", "--speed", "1", "--threads", "4",
               "--device", "cpu"]
    elapsed = run(command, job / "generation.log")
    return job / "speech.wav", elapsed, command


def generate_zipvoice(args, voice="zipvoice_zh_male"):
    job = job_directory(args, voice, TEXT)
    installed = json.loads((args.speech_root / "runtime.json").read_text())
    if installed["runnerSourceSha256"] != digest(ROOT / "scripts/speech-runtime-runner.c"):
        raise ValueError("Prepared native runner does not match the current source")
    runtime = json.loads((args.speech_root / "manifest.json").read_text())
    for item in installed["files"]:
        if digest(args.speech_root / item["path"]) != item["sha256"]:
            raise ValueError(f"Native runtime integrity failed: {item['path']}")
    model = args.zip_model
    reference_name = "male-reference" if voice == "zipvoice_zh_male" else "zipvoice-reference"
    command = [args.speech_root / runtime["executable"],
               f"--zipvoice-encoder={model / 'encoder.onnx'}",
               f"--zipvoice-decoder={model / 'decoder.onnx'}",
               f"--zipvoice-tokens={model / 'tokens.txt'}",
               f"--zipvoice-vocoder={model / 'vocos_24khz.onnx'}",
               f"--zipvoice-lexicon={model / 'lexicon.txt'}",
               f"--zipvoice-data-dir={args.speech_root / 'model/espeak-ng-data'}",
               f"--reference-audio={ASSETS / (reference_name + '.wav')}",
               f"--reference-text-file={ASSETS / (reference_name + '.txt')}",
               "--num-steps=8", "--sample-rate=24000", "--sid=0", "--speed=1",
               f"--text-file={job / 'text.txt'}", f"--output-filename={job / 'speech.wav'}"]
    elapsed = run(command, job / "generation.log")
    return job / "speech.wav", elapsed, command


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python", type=Path, default=Path(sys.executable))
    parser.add_argument("--qwen-model", type=Path, required=True)
    parser.add_argument("--f5-config", type=Path, required=True)
    parser.add_argument("--zip-model", type=Path, required=True)
    parser.add_argument("--runtime-script", type=Path, required=True)
    parser.add_argument("--speech-root", type=Path, required=True)
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--download-qwen", action="store_true")
    parser.add_argument("--phase", choices=("reference", "qwen3", "f5", "zipvoice", "all"), default="all")
    args = parser.parse_args()
    for name in ("python", "qwen_model", "f5_config", "zip_model", "runtime_script", "speech_root", "work"):
        setattr(args, name, getattr(args, name).absolute())
    args.work.mkdir(parents=True, exist_ok=True)
    catalog = json.loads((ROOT / "src-tauri/resources/speech-models.json").read_text())
    models = {item["id"]: item for item in catalog["models"]}
    if args.phase in ("reference", "qwen3", "all"):
        prepare_qwen(models[MODEL_IDS["qwen3_uncle_fu"]], args.qwen_model, args.download_qwen)
    generator = dict(script="scripts/generate-male-voice-previews.py", scriptSha256=digest(Path(__file__)),
                     adapter="scripts/speech-voice-adapter.py",
                     adapterSha256=digest(ROOT / "scripts/speech-voice-adapter.py"),
                     deviceRuntime="scripts/speech-device-runtime.py",
                     deviceRuntimeSha256=digest(ROOT / "scripts/speech-device-runtime.py"),
                     runtimeScriptSha256=digest(args.runtime_script), platform=platform.platform(),
                     python=platform.python_version(), generatedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
    if args.phase in ("f5", "all"):
        config = json.loads(args.f5_config.read_text())
        mapping = {"model_1250000.safetensors": config["model"], "vocab.txt": config["vocabulary"],
                   "vocos/config.yaml": config["vocoderConfig"], "vocos/pytorch_model.bin": config["vocoderModel"]}
        for item in models[MODEL_IDS["f5_zh_male"]]["files"]:
            if item["path"] in mapping:
                verify(args.f5_config.parent / mapping[item["path"]], item)
    if args.phase in ("reference", "all"):
        wav, elapsed, command = generate_python(args, "qwen3_uncle_fu", REFERENCE_TEXT, "reference")
        original = inspect_audio(wav)
        if not 1 <= original["durationSeconds"] <= 15:
            raise ValueError("Reference must contain between one and fifteen seconds of speech")
        reference = ASSETS / "male-reference.wav"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(wav), "-map_metadata", "-1",
                        "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", str(reference)], check=True)
        (ASSETS / "male-reference.txt").write_text(REFERENCE_TEXT, encoding="utf-8")
        write_json(ASSETS / "male-reference.json", dict(schema=1, text=REFERENCE_TEXT, synthetic=True,
                   modelId=MODEL_IDS["qwen3_uncle_fu"], speaker="Uncle_Fu", license="Apache-2.0",
                   source="https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice/tree/0c0e3051f131929182e2c023b9537f8b1c68adfe",
                   sha256=digest(reference), bytes=reference.stat().st_size, originalWavSha256=digest(wav),
                   originalWav=str(wav), generationSeconds=elapsed, audio=inspect_audio(reference),
                   settings=dict(device="cpu", dtype="bfloat16", threads=4, speed=1, seed=20261017,
                                 speaker="Uncle_Fu", config={**json.loads((args.qwen_model / "runner-config.json").read_text()),
                                                             "speaker": "Uncle_Fu"}),
                   modelFiles=[dict(path=item["path"], bytes=item["size"], sha256=item["sha256"])
                               for item in models[MODEL_IDS["qwen3_uncle_fu"]]["files"]],
                   conversion="24 kHz mono FLOAT WAV converted to PCM16; no pitch or tempo change",
                   generator=generator, command=[str(value) for value in command]))
        print(f"REFERENCE READY: {reference}", flush=True)
    if args.phase == "reference":
        return
    manifest_path = PREVIEWS / "male-manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.is_file() else dict(schema=1, text=TEXT, previews=[])
    manifest["text"] = TEXT
    manifest["generator"] = generator
    reference_record = json.loads((ASSETS / "male-reference.json").read_text())
    if digest(ASSETS / "male-reference.wav") != reference_record["sha256"]:
        raise ValueError("Reference does not match its provenance record")
    for voice in ("qwen3_uncle_fu", "f5_zh_male", "zipvoice_zh_male"):
        if args.phase != "all" and not voice.startswith(args.phase):
            continue
        if voice == "zipvoice_zh_male":
            for item in models[MODEL_IDS[voice]]["files"]:
                if item["path"] not in ("reference.wav", "reference.txt"):
                    verify(args.zip_model / item["path"], item)
            wav, elapsed, command = generate_zipvoice(args)
        else:
            wav, elapsed, command = generate_python(args, voice, TEXT, voice)
        original = inspect_audio(wav)
        output = PREVIEWS / f"{voice}.mp3"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(wav), "-map_metadata", "-1",
                        "-c:a", "libmp3lame", "-b:a", "128k", "-ar", "24000", "-ac", "1",
                        "-id3v2_version", "0", str(output)], check=True)
        decoded = inspect_audio(output)
        if abs(original["durationSeconds"] - decoded["durationSeconds"]) > 576 / 24000:
            raise ValueError("Decoded preview duration differs from generated audio")
        record = dict(voiceId=voice, file=output.name, text=TEXT, bytes=output.stat().st_size,
                      sha256=digest(output), wavSha256=digest(wav), wav=str(wav),
                      modelId=MODEL_IDS[voice], generationSeconds=elapsed, **original,
                      modelFiles=[dict(path=item["path"], bytes=item["size"], sha256=item["sha256"])
                                  for item in models[MODEL_IDS[voice]]["files"] if not item.get("embedded")],
                      decodedDurationSeconds=decoded["durationSeconds"], decodedPeak=decoded["peak"],
                      decodedRms=decoded["rms"], referenceAudio=None if voice == "qwen3_uncle_fu" else dict(
                          file="scripts/optional-speech-assets/male-reference.wav", sha256=reference_record["sha256"],
                          text=REFERENCE_TEXT, speaker="Uncle_Fu", synthetic=True),
                      settings=dict(device="cpu", speed=1, sampleRate=24000, channels=1, bitrate=128000),
                      command=[str(value) for value in command], generator=generator)
        if voice == "zipvoice_zh_male":
            record["settings"].update(dtype="float32", threads=1, steps=8, featScale=0.1, tShift=0.5,
                                      targetRms=0.1, guidanceScale=1, silenceScale=1,
                                      textNormalization="Unchanged: the first corpus sentence contains no numbers")
        else:
            config = args.f5_config if voice == "f5_zh_male" else args.qwen_model / "runner-config.json"
            effective_config = json.loads(config.read_text())
            if voice == "qwen3_uncle_fu":
                effective_config["speaker"] = "Uncle_Fu"
            else:
                effective_config["referenceAudio"] = "job/male-reference.wav"
                effective_config["referenceText"] = "job/male-reference.txt"
            record["settings"].update(config=effective_config, threads=4,
                                      dtype="float32" if voice == "f5_zh_male" else "bfloat16",
                                      speaker="Uncle_Fu" if voice == "qwen3_uncle_fu" else "synthetic reference")
        manifest["previews"] = [item for item in manifest["previews"] if item["voiceId"] != voice] + [record]
        write_json(manifest_path, manifest)
        print(f"PREVIEW READY: {voice}: {original['durationSeconds']:.3f}s; synthesis {elapsed:.2f}s", flush=True)


if __name__ == "__main__":
    main()
