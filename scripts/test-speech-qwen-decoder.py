#!/usr/bin/env python3
"""Real codec regression using an already installed local model and audio.

No files are downloaded. CPU runs verify decoder math and the bounded-prefix
comparison; only an explicit CUDA/MPS run verifies that hardware backend.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, required=True, help="Local speech_tokenizer directory")
    parser.add_argument("--reference-audio", type=Path, required=True)
    parser.add_argument("--device", choices=("cpu", "cuda", "mps"), default="cpu")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    import numpy as np
    import soundfile as sf
    import torch
    from qwen_tts import Qwen3TTSTokenizer
    spec = importlib.util.spec_from_file_location("speech_device", Path(__file__).with_name("speech-device-runtime.py"))
    device_runtime = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(device_runtime)
    torch.set_num_threads(4)
    source_audio, source_rate = sf.read(args.reference_audio, dtype="float32")
    tokenizer = Qwen3TTSTokenizer.from_pretrained(str(args.model), device_map="cpu", dtype=torch.float32,
        attn_implementation="eager", local_files_only=True)
    with torch.inference_mode():
        codes = tokenizer.encode(source_audio, sr=source_rate).audio_codes[0]
        encoded = [{"audio_codes": codes}]
        fp32 = tokenizer.decode(encoded)
        tokenizer.model.to(dtype=torch.bfloat16)
        bf16 = tokenizer.decode(encoded)
        precision_error = device_runtime.decoder_relative_error(bf16, fp32, 24000, np)
        prefix_codes = device_runtime.decoder_probe_codes(encoded)
        started = time.monotonic()
        prefix = tokenizer.decode(prefix_codes)
        prefix_seconds = time.monotonic() - started
        observed = ([bf16[0][0][:len(prefix[0][0])]], bf16[1])
        prefix_error = device_runtime.decoder_relative_error(observed, prefix, 24000, np, allow_silence=True)
        assert prefix_error <= 0.1, "Bounded codec prefix changed decoder semantics"

        device_error = None
        if args.device != "cpu":
            tokenizer.model.to(device=args.device)
            tokenizer.device = torch.device(args.device)
            observed_full = tokenizer.decode(encoded)
            device_runtime.synchronize(torch, args.device)
            observed_prefix = ([observed_full[0][0][:len(prefix[0][0])]], observed_full[1])
            device_error = device_runtime.decoder_relative_error(observed_prefix, prefix, 24000, np, allow_silence=True)
            assert device_error <= 0.1, "Accelerated decoder differs from CPU reference"

    # finite/non-silent is insufficient: the gate must reject finite noise,
    # mismatched sample counts/rates, and non-finite output as well.
    reference = prefix
    noise = np.random.default_rng(20261018).normal(0, .15, len(reference[0][0])).astype(np.float32)
    rejected = {
        "finiteNoise": device_runtime.decoder_relative_error(([noise], 24000), reference, 24000, np) > .1,
        "wrongLength": device_runtime.decoder_relative_error(([noise[:-1]], 24000), reference, 24000, np) > .1,
        "wrongRate": device_runtime.decoder_relative_error((reference[0], 16000), reference, 24000, np) > .1,
        "nonFinite": device_runtime.decoder_relative_error(([np.full_like(noise, np.nan)], 24000), reference, 24000, np) > .1,
    }
    assert all(rejected.values())
    result = dict(schema=1, status="passed", device=args.device, hardwareGpuVerified=args.device != "cpu",
        torchVersion=torch.__version__, sampleRate=24000, codeShape=list(codes.shape),
        audioSeconds=len(bf16[0][0]) / 24000, cpuProbeAudioSeconds=len(prefix[0][0]) / 24000,
        cpuProbeElapsedSeconds=prefix_seconds, cpuPrefixRelativeRmsError=prefix_error,
        bf16VersusFp32RelativeRmsError=precision_error, gpuRelativeRmsError=device_error,
        numericalErrorLimit=.1, invalidOutputsRejected=rejected,
        limitations="Decoder math only; no M5 reproduction, no subtitle recognition or intelligibility score.")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
