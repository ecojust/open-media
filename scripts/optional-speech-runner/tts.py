#!/usr/bin/env python3
"""Offline inference entry point for the downloaded speech runtime.

The runtime contains its own interpreter, dependencies and the pinned inference
source. A verified model package supplies runner-config.json and local weights;
neither invocation nor dependency probes download files. Model precision is part
of the package contract and is never changed to accommodate a platform.
"""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import sys
import tempfile
import types


ROOT = Path(__file__).resolve().parent
SAMPLE_RATE = 24_000
MAX_TEXT_CHARS = 4_000
F5_SOURCE_REVISION = "2f866649b779881af8bd644e76b9a6d95053da29"


def stage(name: str, **fields) -> None:
    suffix = "".join(f",{key}={value}" for key, value in fields.items())
    print(f"stage={name}{suffix}", flush=True)


def progress(samples: int, completed: int, total: int) -> None:
    print(f"sample={samples}, progress={completed / total:.6f}", flush=True)


def configure_process(threads: int) -> None:
    # Set these before importing packages, including any transitive imports.
    for name in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_DATASETS_OFFLINE",
                 "HF_HUB_DISABLE_TELEMETRY", "DO_NOT_TRACK"):
        os.environ[name] = "1"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    os.environ["OMP_NUM_THREADS"] = str(threads)
    os.environ["MKL_NUM_THREADS"] = str(threads)
    os.environ["NUMBA_NUM_THREADS"] = str(threads)
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")

    def deny_network(event, args):
        if event == "socket.connect":
            address = args[1]
            if isinstance(address, tuple):
                raise RuntimeError("The installed speech runtime cannot access the network")

    sys.addaudithook(deny_network)


def local_path(root: Path, value: str, *, directory: bool = False) -> Path:
    """Resolve package paths without accepting a different model directory."""
    if not isinstance(value, str) or not value or "\\" in value or ":" in value:
        raise ValueError("Invalid model package path")
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or (value == "." and not directory):
        raise ValueError("Model package path must be relative")
    resolved = (root / value).resolve(strict=True)
    if not resolved.is_relative_to(root.resolve(strict=True)):
        raise ValueError("Model package path leaves its directory")
    if directory and not resolved.is_dir():
        raise ValueError("Model directory is missing")
    if not directory and not resolved.is_file():
        raise ValueError("Model file is missing")
    return resolved


def load_config(path: Path) -> tuple[dict, Path]:
    if path.stat().st_size > 64 * 1024:
        raise ValueError("Model configuration is too large")
    config = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(config, dict) or config.get("schema") != 1:
        raise ValueError("Unsupported model configuration schema")
    if config.get("sampleRate") != SAMPLE_RATE:
        raise ValueError("The model must generate 24000 Hz audio")
    engine = config.get("engine")
    if engine == "f5":
        if config.get("dtype") != "float32":
            raise ValueError("This model package requires float32 inference")
        expected = {"steps": 32, "cfgStrength": 2.0, "swaySamplingCoefficient": -1.0}
        if any(config.get(key) != value for key, value in expected.items()):
            raise ValueError("Unsupported model inference settings")
    elif engine == "qwen3":
        if config.get("dtype") != "bfloat16":
            raise ValueError("This model package requires bfloat16 inference")
        if config.get("speaker") != "Serena" or config.get("language") != "Chinese":
            raise ValueError("Unsupported model voice")
        if config.get("instruct") != "用自然流畅的标准普通话朗读，语气温和，语速适中。":
            raise ValueError("Unsupported model voice instruction")
    else:
        raise ValueError("Unsupported speech engine")
    seed = config.get("seed")
    if not isinstance(seed, int) or isinstance(seed, bool) or not 0 <= seed < 2**32:
        raise ValueError("Invalid inference seed")
    return config, path.resolve(strict=True).parent


def read_text(path: Path) -> str:
    if path.stat().st_size > MAX_TEXT_CHARS * 8:
        raise ValueError("Speech text exceeds the supported size")
    text = path.read_text(encoding="utf-8-sig").strip()
    if not text or not any(char.isalnum() for char in text):
        raise ValueError("Speech text must contain readable words")
    if len(text) > MAX_TEXT_CHARS or "\x00" in text:
        raise ValueError("Speech text exceeds the supported size or contains null characters")
    return text


def split_text(text: str, max_bytes: int) -> list[str]:
    """Keep punctuation, and bound unpunctuated sentences without dropping text."""
    if max_bytes < 4:
        raise ValueError("Invalid speech chunk size")
    pieces = re.split(r"(?<=[;:,.!?])\s+|(?<=[；：，。！？\n])", text)
    chunks, current = [], ""
    for piece in pieces:
        if not piece:
            continue
        suffix = " " if len(piece[-1].encode("utf-8")) == 1 else ""
        candidate = piece + suffix
        if len((current + candidate).encode("utf-8")) <= max_bytes:
            current += candidate
            continue
        if current.strip():
            chunks.append(current.strip())
        current = ""
        for char in candidate:
            if len((current + char).encode("utf-8")) > max_bytes:
                if current.strip():
                    chunks.append(current.strip())
                current = ""
            current += char
    if current.strip():
        chunks.append(current.strip())
    return chunks


def import_f5():
    source = ROOT / "vendor" / "f5_tts"
    if not (source / "model" / "cfm.py").is_file():
        raise ValueError("The installed inference source is incomplete")
    sys.path.insert(0, str(source.parent))
    # Inference does not need the upstream package's training initializer.
    namespace = types.ModuleType("f5_tts.model")
    namespace.__path__ = [str(source / "model")]
    sys.modules["f5_tts.model"] = namespace
    from f5_tts.model.backbones.dit import DiT
    from f5_tts.model.cfm import CFM
    from f5_tts.model.utils import convert_char_to_pinyin, get_tokenizer
    from safetensors.torch import load_file
    from vocos import Vocos
    return DiT, CFM, convert_char_to_pinyin, get_tokenizer, load_file, Vocos


def verify_bf16(torch) -> None:
    """Exercise the CPU primitives the model depends on, without a dtype fallback."""
    import torch.nn.functional as functional
    dtype = torch.bfloat16
    x = torch.randn(1, 4, 16, dtype=dtype)
    outputs = [torch.nn.Linear(16, 8).to(dtype)(x)]
    q = torch.randn(1, 2, 4, 16, dtype=dtype)
    outputs.append(functional.scaled_dot_product_attention(q, q, q))
    conv_input = torch.randn(1, 4, 16, dtype=dtype)
    outputs.append(torch.nn.Conv1d(4, 8, 3, padding=1).to(dtype)(conv_input))
    outputs.append(torch.nn.ConvTranspose1d(4, 8, 3, stride=2).to(dtype)(conv_input))
    outputs.append(functional.layer_norm(x, (16,)))
    for result in outputs:
        if result.dtype != dtype or not torch.isfinite(result).all():
            raise RuntimeError("This CPU runtime cannot execute the required bfloat16 operations")


def checked_audio(samples, np):
    samples = np.asarray(samples, dtype=np.float32).reshape(-1)
    if not samples.size or not np.isfinite(samples).all():
        raise RuntimeError("Speech generation returned invalid audio")
    if float(np.sqrt(np.mean(samples.astype(np.float64) ** 2))) < 1e-5:
        raise RuntimeError("Speech generation returned silent audio")
    return samples


def join_audio(parts: list, crossfade_seconds: float, np):
    combined = parts[0]
    for samples in parts[1:]:
        overlap = min(round(crossfade_seconds * SAMPLE_RATE), len(combined), len(samples))
        if overlap:
            fade = np.linspace(0, 1, overlap)
            combined = np.concatenate((combined[:-overlap],
                combined[-overlap:] * (1 - fade) + samples[:overlap] * fade,
                samples[overlap:]))
        else:
            combined = np.concatenate((combined, samples))
    return np.asarray(combined, dtype=np.float32)


def generate_f5(config: dict, root: Path, text: str, speed: float, torch, np, sf):
    DiT, CFM, convert_char_to_pinyin, get_tokenizer, load_file, Vocos = import_f5()
    vocabulary, count = get_tokenizer(str(local_path(root, config["vocabulary"])), "custom")
    model = CFM(
        transformer=DiT(dim=1024, depth=22, heads=16, ff_mult=2, text_dim=512,
            text_mask_padding=True, qk_norm=None, conv_layers=4, pe_attn_head=None,
            attn_backend="torch", attn_mask_enabled=False, checkpoint_activations=False,
            text_num_embeds=count, mel_dim=100),
        mel_spec_kwargs={"n_fft": 1024, "hop_length": 256, "win_length": 1024,
            "n_mel_channels": 100, "target_sample_rate": SAMPLE_RATE, "mel_spec_type": "vocos"},
        odeint_kwargs={"method": "euler"}, vocab_char_map=vocabulary,
    ).to(device="cpu", dtype=torch.float32)
    weights = load_file(str(local_path(root, config["model"])), device="cpu")
    weights = {key.replace("ema_model.", ""): value for key, value in weights.items()
               if key not in ("initted", "step")}
    for key in ("mel_spec.mel_stft.mel_scale.fb", "mel_spec.mel_stft.spectrogram.window"):
        weights.pop(key, None)
    model.load_state_dict(weights, strict=True)
    del weights
    model.eval()
    vocoder = Vocos.from_hparams(str(local_path(root, config["vocoderConfig"])))
    vocoder.load_state_dict(torch.load(str(local_path(root, config["vocoderModel"])),
                                      map_location="cpu", weights_only=True))
    vocoder.to(device="cpu", dtype=torch.float32).eval()
    reference, sample_rate = sf.read(local_path(root, config["referenceAudio"]), dtype="float32")
    if sample_rate != SAMPLE_RATE or reference.ndim != 1 or not 1 <= len(reference) / sample_rate <= 15:
        raise ValueError("Invalid local reference audio")
    reference = checked_audio(reference, np)
    reference_text = read_text(local_path(root, config["referenceText"]))
    audio = torch.from_numpy(reference).unsqueeze(0)
    reference_rms = torch.sqrt(torch.mean(audio.square()))
    if reference_rms < 0.1:
        audio = audio * 0.1 / reference_rms
    reference_frames = audio.shape[-1] // 256
    reference_bytes = len(reference_text.encode("utf-8"))
    max_bytes = max(4, int(reference_bytes / (len(reference) / sample_rate)
                           * (22 - len(reference) / sample_rate) * min(speed, 1.0)))
    chunks = split_text(text, max_bytes)
    stage("generating", engine="f5", dtype="float32", chunks=len(chunks))
    parts, sample_count = [], 0
    for index, chunk in enumerate(chunks):
        chunk_speed = speed * (0.3 if len(chunk.encode("utf-8")) < 10 else 1.0)
        duration = reference_frames + int(reference_frames / reference_bytes
                                          * len(chunk.encode("utf-8")) / chunk_speed)
        with torch.inference_mode():
            generated, trajectory = model.sample(cond=audio,
                text=convert_char_to_pinyin([reference_text + chunk]), duration=duration,
                steps=config["steps"], cfg_strength=config["cfgStrength"],
                sway_sampling_coef=config["swaySamplingCoefficient"], seed=config["seed"] + index)
            del trajectory
            mel = generated[:, reference_frames:, :].float().permute(0, 2, 1)
            wave = vocoder.decode(mel)
            if reference_rms < 0.1:
                wave = wave * reference_rms / 0.1
            samples = checked_audio(wave.squeeze().cpu().numpy(), np)
        parts.append(samples)
        sample_count += len(samples)
        progress(sample_count, index + 1, len(chunks))
    return join_audio(parts, 0.15, np)


def generate_qwen(config: dict, root: Path, text: str, speed: float, torch, np):
    from qwen_tts import Qwen3TTSModel
    verify_bf16(torch)
    model = Qwen3TTSModel.from_pretrained(str(local_path(root, config["model"], directory=True)),
        device_map="cpu", dtype=torch.bfloat16, attn_implementation="sdpa",
        local_files_only=True, low_cpu_mem_usage=True)
    # Some audio decoding modules intentionally use FP32. The speech-generation
    # transformer itself must retain the requested BF16 weights and operations.
    talker = getattr(model.model, "talker", None)
    if talker is None or next(talker.parameters()).dtype != torch.bfloat16:
        raise RuntimeError("The speech-generation model did not load in bfloat16")
    original_generate = talker.generate

    def generate_until_end(*args, **kwargs):
        result = original_generate(*args, **kwargs)
        verify_generation_stop(result.sequences, model.model.config.talker_config.codec_eos_token_id)
        return result

    # The public audio API otherwise discards stop-token information and can
    # return a truncated waveform when max_new_tokens is reached.
    talker.generate = generate_until_end
    chunks = split_text(text, 300)
    stage("generating", engine="qwen3", dtype="bfloat16", chunks=len(chunks))
    parts, sample_count = [], 0
    for index, chunk in enumerate(chunks):
        torch.manual_seed(config["seed"] + index)
        np.random.seed(config["seed"] + index)
        with torch.inference_mode():
            waves, sample_rate = model.generate_custom_voice(text=chunk, language=config["language"],
                speaker=config["speaker"], instruct=config["instruct"], non_streaming_mode=True,
                do_sample=True, temperature=0.9, top_p=1.0, top_k=50,
                repetition_penalty=1.05, subtalker_dosample=True, subtalker_temperature=0.9,
                subtalker_top_p=1.0, subtalker_top_k=50, max_new_tokens=2048)
        if sample_rate != SAMPLE_RATE or len(waves) != 1:
            raise RuntimeError("Unexpected generated audio format")
        samples = checked_audio(waves[0], np)
        if speed != 1:
            import librosa
            samples = checked_audio(librosa.effects.time_stretch(samples, rate=speed), np)
        parts.append(samples)
        sample_count += len(samples)
        progress(sample_count, index + 1, len(chunks))
    return join_audio(parts, 0.03, np)


def verify_generation_stop(sequences, eos_token_id: int) -> None:
    if len(sequences) != 1 or not len(sequences[0]) or int(sequences[0][-1]) != eos_token_id:
        raise RuntimeError("Speech generation did not reach its end token; shorten the subtitle and retry")


def write_audio(path: Path, samples, np, sf) -> dict:
    samples = checked_audio(samples, np)
    # FLOAT WAV retains finite vocoder peaks above full scale for the editor's
    # normal export pipeline rather than silently clipping during synthesis.
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".part")
    try:
        sf.write(temporary, samples, SAMPLE_RATE, format="WAV", subtype="FLOAT")
        decoded, rate = sf.read(temporary, dtype="float32")
        if rate != SAMPLE_RATE or decoded.shape != samples.shape or not np.array_equal(decoded, samples):
            raise RuntimeError("Generated audio failed its write/read verification")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
    return {"sampleRate": SAMPLE_RATE, "sampleCount": len(samples),
            "audioSeconds": len(samples) / SAMPLE_RATE,
            "peak": float(np.max(np.abs(samples))),
            "rms": float(np.sqrt(np.mean(samples.astype(np.float64) ** 2)))}


def self_test(engine: str, torch, np, sf) -> dict:
    import torchaudio
    import librosa
    import safetensors
    import transformers
    import accelerate
    if engine in ("all", "f5"):
        import_f5()
    if engine in ("all", "qwen3"):
        from qwen_tts import Qwen3TTSModel
        verify_bf16(torch)
    time = np.arange(SAMPLE_RATE // 10, dtype=np.float32) / SAMPLE_RATE
    wave = np.sin(time * 2 * np.pi * 440).astype(np.float32) * 0.1
    with tempfile.TemporaryDirectory(prefix="speech-probe-") as directory:
        probe = write_audio(Path(directory) / "audio.wav", wave, np, sf)
    versions = {name: importlib.metadata.version(name) for name in
                ("torch", "torchaudio", "numpy", "soundfile", "transformers", "accelerate",
                 "librosa", "safetensors", "vocos", "qwen-tts")}
    return {"schema": 1, "ok": True, "engine": engine, "python": sys.version.split()[0],
            "packages": versions, "f5SourceRevision": F5_SOURCE_REVISION,
            "bf16": engine in ("all", "qwen3"), "audioProbe": probe}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path)
    parser.add_argument("--text-file", type=Path)
    parser.add_argument("--output-filename", type=Path)
    parser.add_argument("--speed", type=float, default=1)
    parser.add_argument("--threads", type=int, default=min(4, os.cpu_count() or 1))
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--engine", choices=("all", "f5", "qwen3"), default="all")
    args = parser.parse_args()
    if not 1 <= args.threads <= 32 or not math.isfinite(args.speed) or not 0.5 <= args.speed <= 2:
        parser.error("Supported threads: 1..32; speed: 0.5..2")
    if not args.self_test and not all((args.config, args.text_file, args.output_filename)):
        parser.error("--config, --text-file and --output-filename are required")
    configure_process(args.threads)
    # Validate user inputs before allocating model memory.
    config, root = load_config(args.config) if not args.self_test else (None, None)
    text = read_text(args.text_file) if not args.self_test else None
    stage("loading")
    import numpy as np
    import soundfile as sf
    import torch
    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(1)
    if args.self_test:
        print(json.dumps(self_test(args.engine, torch, np, sf), ensure_ascii=False), flush=True)
        return
    if config["engine"] == "f5":
        wave = generate_f5(config, root, text, args.speed, torch, np, sf)
    else:
        wave = generate_qwen(config, root, text, args.speed, torch, np)
    report = write_audio(args.output_filename, wave, np, sf)
    stage("complete", engine=config["engine"], dtype=config["dtype"])
    print(json.dumps(report), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Speech runtime failed: {type(error).__name__}: {error}", file=sys.stderr, flush=True)
        sys.exit(1)
