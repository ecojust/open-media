#!/usr/bin/env python3
"""Generate bundled auditions from the prepared local model, without an app build."""

import argparse
import array
import ctypes as c
import hashlib
import json
import math
import pathlib
import re
import subprocess
import sys
import tarfile
import tempfile
import time


ROOT = pathlib.Path(__file__).resolve().parents[1]
TEXTS = {
    "zh": "你好，这是一段语音试听。让文字拥有清晰自然的声音。",
    "en": "Hello, this is a voice preview. Let your story come to life with a clear and natural voice.",
}
SETTINGS = {"speed": 1, "silenceScale": 0.2, "sampleRate": 16000, "noiseScale": 1,
            "channels": 1, "bitrate": 64000, "threads": 2}


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def public_header(lock):
    source = next(item for item in lock["sources"] if item["id"] == "sherpa-onnx")
    archive = ROOT / ".speech-runtime/downloads" / source["archive"]
    if not archive.is_file() or sha256(archive) != source["sha256"]:
        raise RuntimeError("Prepare the pinned speech source archive before generating previews.")
    with tarfile.open(archive) as contents:
        member = next(item for item in contents.getmembers()
                      if item.isfile() and item.name.endswith("/sherpa-onnx/c-api/c-api.h"))
        return contents.extractfile(member).read()


def bind_library(library_path, header, version):
    # Derive ABI structs from the matching public header rather than copying a layout.
    types = {"int32_t": c.c_int32, "float": c.c_float,
             "const char *": c.c_char_p, "const float *": c.POINTER(c.c_float)}
    pattern = r"typedef struct (SherpaOnnx(?:OfflineTts\w*Config|GeneratedAudio|GenerationConfig))\s*\{(.*?)\}\s*\1;"
    for match in re.finditer(pattern, header.decode(), re.S):
        name, body = match.groups()
        body = re.sub(r"/\*.*?\*/", "", body, flags=re.S)
        fields = []
        for field in body.split(";"):
            field = re.sub(r"\s+", " ", field.strip())
            if field:
                declaration = re.fullmatch(r"(.+?)([A-Za-z_]\w*)", field)
                if not declaration:
                    raise RuntimeError(f"Unsupported public C field: {field}")
                field_type, field_name = declaration.groups()
                fields.append((field_name, types[field_type.strip()]))
        types[name] = type(name, (c.Structure,), {"_fields_": fields})
    config_type = types["SherpaOnnxOfflineTtsConfig"]
    generation_type = types["SherpaOnnxGenerationConfig"]
    audio_type = types["SherpaOnnxGeneratedAudio"]
    lib = c.CDLL(str(library_path))
    lib.SherpaOnnxGetVersionStr.restype = c.c_char_p
    actual_version = lib.SherpaOnnxGetVersionStr().decode().removeprefix("v")
    if actual_version != version:
        raise RuntimeError(f"Runtime/header version mismatch: {actual_version} != {version}")
    signatures = {
        "SherpaOnnxCreateOfflineTts": ([c.POINTER(config_type)], c.c_void_p),
        "SherpaOnnxOfflineTtsGenerateWithConfig": (
            [c.c_void_p, c.c_char_p, c.POINTER(generation_type), c.c_void_p, c.c_void_p],
            c.POINTER(audio_type)),
        "SherpaOnnxDestroyOfflineTtsGeneratedAudio": ([c.POINTER(audio_type)], None),
        "SherpaOnnxDestroyOfflineTts": ([c.c_void_p], None),
        "SherpaOnnxWriteWave": (
            [c.POINTER(c.c_float), c.c_int32, c.c_int32, c.c_char_p], c.c_int32),
    }
    for name, (arguments, result) in signatures.items():
        function = getattr(lib, name)
        function.argtypes, function.restype = arguments, result
    return lib, config_type, generation_type


def decode_check(path):
    probe = subprocess.run([
        "ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
        "stream=codec_name,sample_rate,channels", "-of", "json", str(path),
    ], check=True, capture_output=True, text=True)
    stream = json.loads(probe.stdout)["streams"][0]
    if stream != {"codec_name": "mp3", "sample_rate": str(SETTINGS["sampleRate"]), "channels": 1}:
        raise RuntimeError(f"Unexpected audio format: {path}: {stream}")
    decoded = subprocess.run([
        "ffmpeg", "-v", "error", "-i", str(path), "-f", "f32le", "-acodec",
        "pcm_f32le", "-",
    ], check=True, capture_output=True).stdout
    samples = array.array("f")
    samples.frombytes(decoded)
    if sys.byteorder != "little":
        samples.byteswap()
    if not samples or not all(math.isfinite(sample) for sample in samples):
        raise RuntimeError(f"Empty or invalid decoded audio: {path}")
    peak = max(abs(sample) for sample in samples)
    if peak < 0.01:
        raise RuntimeError(f"Silent generated preview: {path}")
    return len(samples) / SETTINGS["sampleRate"], peak


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--speech-root", type=pathlib.Path,
                        default=ROOT / "src-tauri/resources/speech")
    parser.add_argument("--manifest", type=pathlib.Path,
                        help="Existing runtime manifest; default is inside --speech-root.")
    parser.add_argument("--library", type=pathlib.Path,
                        help="Existing C API library; default is the prepared Linux runtime.")
    parser.add_argument("--output", type=pathlib.Path,
                        default=ROOT / "src/assets/voice-previews")
    parser.add_argument("--wav-dir", type=pathlib.Path,
                        help="Retain uncompressed generation evidence outside the repository.")
    args = parser.parse_args()
    speech_root = args.speech_root.resolve()
    library_path = (args.library or speech_root / "runtime/lib/libsherpa-onnx-c-api.so").resolve()
    output = args.output.resolve()
    work = args.wav_dir.resolve() if args.wav_dir else pathlib.Path(
        tempfile.mkdtemp(prefix="open-media-voice-previews-"))
    output.mkdir(parents=True, exist_ok=True)
    work.mkdir(parents=True, exist_ok=True)
    lock = json.loads((ROOT / "scripts/speech-runtime.lock.json").read_text())
    runtime = json.loads((args.manifest or speech_root / "manifest.json").read_text())
    if runtime["version"] != lock["engine"]["version"]:
        raise RuntimeError("Prepared runtime does not match the locked engine version.")
    voices = {voice["id"]: voice for voice in runtime["voices"]}
    groups_path = ROOT / "src/core/voice-groups.ts"
    ids = re.findall(r"\brepresentative[\"']?\s*:\s*[\"']([a-z0-9_-]+)[\"']", groups_path.read_text())
    if not ids or len(ids) != len(set(ids)) or not all(voice in voices for voice in ids):
        raise RuntimeError("Missing, duplicate or unknown representative voices.")
    header = public_header(lock)
    lib, config_type, generation_type = bind_library(library_path, header, lock["engine"]["version"])
    config = config_type()
    model = runtime["model"]
    if model.get("kind") != "matcha" or model.get("sampleRate") != SETTINGS["sampleRate"]:
        raise RuntimeError("Preview generation requires the bundled bilingual model.")
    for attr, key in [("acoustic_model", "file"), ("vocoder", "vocoder"),
                      ("tokens", "tokens"), ("data_dir", "dataDir")]:
        setattr(config.model.matcha, attr, str(speech_root / model[key]).encode())
    config.model.matcha.length_scale = 1
    config.model.matcha.noise_scale = SETTINGS["noiseScale"]
    config.model.matcha.lexicon = ",".join(str(speech_root / p) for p in model["lexicons"]).encode()
    config.rule_fsts = ",".join(str(speech_root / p) for p in model["ruleFsts"]).encode()
    config.model.num_threads = SETTINGS["threads"]
    config.model.provider = b"cpu"
    config.max_num_sentences = 1
    config.silence_scale = SETTINGS["silenceScale"]
    print(f"Loading existing model once for {len(ids)} voices…", flush=True)
    engine = lib.SherpaOnnxCreateOfflineTts(c.byref(config))
    if not engine:
        raise RuntimeError("Cannot load the prepared local speech model.")
    previews = []
    try:
        for voice_id in ids:
            voice = voices[voice_id]
            language = "zh" if voice["language"].lower().startswith("zh") else "en"
            generation = generation_type()
            generation.sid = voice["speakerId"]
            generation.speed = SETTINGS["speed"]
            generation.silence_scale = SETTINGS["silenceScale"]
            started = time.monotonic()
            audio = lib.SherpaOnnxOfflineTtsGenerateWithConfig(
                engine, TEXTS[language].encode(), c.byref(generation), None, None)
            wav = work / f"{voice_id}.wav"
            try:
                if not audio or audio.contents.n <= 0 or audio.contents.sample_rate != SETTINGS["sampleRate"]:
                    raise RuntimeError(f"Invalid synthesis output: {voice_id}")
                raw = audio.contents
                samples = array.array("f")
                samples.frombytes(c.string_at(raw.samples, raw.n * c.sizeof(c.c_float)))
                if not all(math.isfinite(sample) for sample in samples):
                    raise RuntimeError(f"Non-finite synthesis output: {voice_id}")
                peak = max(abs(sample) for sample in samples)
                if not lib.SherpaOnnxWriteWave(raw.samples, raw.n, raw.sample_rate, str(wav).encode()):
                    raise RuntimeError(f"Could not write synthesis output: {voice_id}")
                duration = raw.n / raw.sample_rate
            finally:
                if audio:
                    lib.SherpaOnnxDestroyOfflineTtsGeneratedAudio(audio)
            temporary = work / f"{voice_id}.mp3"
            subprocess.run([
                "ffmpeg", "-v", "error", "-y", "-i", str(wav), "-map_metadata", "-1",
                "-codec:a", "libmp3lame", "-b:a", "64k", "-ar", str(SETTINGS["sampleRate"]), "-ac", "1",
                "-id3v2_version", "0", str(temporary),
            ], check=True)
            decoded_duration, decoded_peak = decode_check(temporary)
            # Encoding may retain a short tail; bound it to one MP3 frame.
            if abs(decoded_duration - duration) > 576 / SETTINGS["sampleRate"]:
                raise RuntimeError(f"Decoded duration does not match generated audio: {voice_id}")
            destination = output / f"{voice_id}.mp3"
            destination.write_bytes(temporary.read_bytes())
            previews.append({
                "voiceId": voice_id, "speakerId": voice["speakerId"], "language": voice["language"],
                "file": destination.name, "durationSeconds": round(duration, 6),
                "decodedDurationSeconds": round(decoded_duration, 6),
                "sha256": sha256(destination), "bytes": destination.stat().st_size,
                "peak": round(peak, 6), "decodedPeak": round(decoded_peak, 6), "wavSha256": sha256(wav),
            })
            print(f"{voice_id}: {duration:.2f}s, {destination.stat().st_size} bytes, "
                  f"generated and decoded in {time.monotonic() - started:.2f}s", flush=True)
    finally:
        lib.SherpaOnnxDestroyOfflineTts(engine)
    manifest = {
        "schema": 1, "texts": TEXTS, "settings": SETTINGS,
        "model": {"id": lock["model"]["id"], "version": lock["model"]["version"],
                  "sha256": sha256(speech_root / model["file"]),
                  "vocoderSha256": sha256(speech_root / model["vocoder"])},
        "engine": {"id": lock["engine"]["id"], "version": lock["engine"]["version"],
                   "librarySha256": sha256(library_path)},
        "generator": {"mode": "existing-c-api", "scriptSha256": sha256(pathlib.Path(__file__)),
                      "headerSha256": hashlib.sha256(header).hexdigest(),
                      "voiceGroupsSha256": sha256(groups_path),
                      "encoder": subprocess.run(["ffmpeg", "-version"], check=True,
                                                capture_output=True, text=True).stdout.splitlines()[0]},
        "previews": previews,
    }
    (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print(f"Verified {len(previews)} previews; total {sum(p['bytes'] for p in previews)} bytes. WAV evidence: {work}")


if __name__ == "__main__":
    main()
