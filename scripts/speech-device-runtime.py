"""Application-owned GPU dispatch over an immutable offline speech runtime.

The verified runtime retains configuration, path, text and output validation.
Only the inference device changes: requested model precision and synthesis
parameters remain the same. A failed GPU attempt is discarded before one CPU
attempt; cancellation and output-file errors never restart inference.
"""

from __future__ import annotations

import gc
import os
import sys


DEVICES = ("auto", "cuda", "mps", "cpu")


def safe_reason(error: Exception | str) -> str:
    text = str(error) if isinstance(error, str) else f"{type(error).__name__}: {error}"
    return " ".join(text.replace(",", ";").split())[:160] or "GPU execution is unavailable"


def report_device(runtime, device: str, config: dict) -> None:
    runtime.stage("device", device=device, engine=config["engine"], dtype=config["dtype"])


def report_audio_cpu(runtime, device: str, config: dict, reason: str) -> None:
    runtime.stage("device", device=device, engine=config["engine"], dtype=config["dtype"],
                  partial="audio-cpu", reason=safe_reason(reason))


def gpu_candidates(torch, requested: str) -> list[str]:
    if requested not in DEVICES:
        raise ValueError("Unsupported speech inference device")
    if requested != "auto":
        return [] if requested == "cpu" else [requested]
    # CUDA and MPS are alternative platform backends. Do not load multiple
    # models or keep a second GPU allocation alive while attempting fallback.
    if torch.cuda.is_available():
        return ["cuda"]
    mps = getattr(torch.backends, "mps", None)
    if mps is not None and mps.is_built() and mps.is_available():
        return ["mps"]
    return []


def synchronize(torch, device: str) -> None:
    if device == "cuda":
        torch.cuda.synchronize()
    elif device == "mps":
        torch.mps.synchronize()


def release_device(torch, device: str) -> None:
    # Generation wrappers may form cycles around the model's bound methods.
    # Drop them before asking the allocator to release unused GPU storage.
    gc.collect()
    try:
        if device == "cuda":
            torch.cuda.empty_cache()
        elif device == "mps":
            torch.mps.empty_cache()
    except Exception as error:
        print(f"GPU cleanup: {safe_reason(error)}", file=sys.stderr, flush=True)


def qwen_attention_implementation(device: str) -> str:
    # The MPS SDPA kernel in the released runtime cannot safely execute the
    # model's 16-query/8-key-value grouped attention. Eager attention explicitly
    # repeats key/value heads before matmul and keeps all model weights in BF16.
    return "eager" if device == "mps" else "sdpa"


def probe_qwen_grouped_attention(torch, device: str):
    from types import SimpleNamespace
    from qwen_tts.core.models.modeling_qwen3_tts import eager_attention_forward
    # Exercise both prefill and cached decode with the real model head counts.
    # Equal-head q/q/q probes cannot expose grouped-attention shape failures.
    outputs = []
    module = SimpleNamespace(num_key_value_groups=2, training=False)
    for query_length, key_length in ((49, 49), (1, 50)):
        query = torch.randn(1, 16, query_length, 128, device=device, dtype=torch.bfloat16)
        key = torch.randn(1, 8, key_length, 128, device=device, dtype=torch.bfloat16)
        value = torch.randn_like(key)
        mask = None
        if query_length > 1:
            mask = torch.full((query_length, key_length), float("-inf"), device=device, dtype=query.dtype)
            mask = torch.triu(mask, diagonal=1)[None, None]
        if qwen_attention_implementation(device) == "eager":
            output, _ = eager_attention_forward(module, query, key, value, mask, scaling=128 ** -0.5)
        else:
            output = torch.nn.functional.scaled_dot_product_attention(
                query, key, value, attn_mask=mask, enable_gqa=True).transpose(1, 2).contiguous()
        if output.shape != (1, query_length, 16, 128):
            raise RuntimeError("Grouped speech attention returned an unexpected shape")
        # A finite tensor can still be numerically wrong on an accelerated
        # backend. Compare the actual grouped/masked operation to independent
        # CPU FP32 math before allowing it to generate discrete audio codes.
        reference, _ = eager_attention_forward(
            module, query.float().cpu(), key.float().cpu(), value.float().cpu(),
            mask.float().cpu() if mask is not None else None, scaling=128 ** -0.5)
        torch.testing.assert_close(output.float().cpu(), reference, rtol=0.03, atol=0.02)
        outputs.append(output)
    return outputs


def probe_device(torch, device: str, engine: str) -> None:
    """Exercise required dtypes/operations instead of trusting a device name."""
    if device == "cuda":
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA is unavailable in the installed runtime or hardware")
        if engine == "qwen3" and not torch.cuda.is_bf16_supported():
            raise RuntimeError("CUDA does not support the required bfloat16 precision")
    elif device == "mps":
        mps = getattr(torch.backends, "mps", None)
        if mps is None or not mps.is_built() or not mps.is_available():
            raise RuntimeError("MPS is unavailable in the installed runtime or hardware")
        if engine == "qwen3" and not mps.is_macos_or_newer(14, 0):
            raise RuntimeError("MPS bfloat16 requires macOS 14 or newer")
    else:
        raise ValueError("A GPU probe requires cuda or mps")

    import torch.nn.functional as functional
    dtype = torch.bfloat16 if engine == "qwen3" else torch.float32
    with torch.inference_mode():
        x = torch.randn(1, 4, 16, device=device, dtype=dtype)
        values = [
            torch.nn.Linear(16, 8).to(device=device, dtype=dtype)(x),
            functional.layer_norm(x, (16,)),
        ]
        if engine == "f5":
            q = torch.randn(1, 2, 4, 16, device=device, dtype=dtype)
            values.append(functional.scaled_dot_product_attention(q, q, q))
            # Convolution is part of the F5 transformer. FFT and waveform
            # reconstruction are separate capabilities checked below.
            conv_input = torch.randn(1, 4, 16, device=device, dtype=dtype)
            values.append(torch.nn.Conv1d(4, 8, 3, padding=1).to(device=device, dtype=dtype)(conv_input))
        else:
            values.extend(probe_qwen_grouped_attention(torch, device))
            # Autoregressive sampling must stay on the selected device too.
            probabilities = torch.softmax(x[0, 0].float(), dim=-1)
            sampled = torch.multinomial(probabilities, 1)
            if sampled.device.type != device:
                raise RuntimeError("GPU sampling ran on an unexpected device")
        synchronize(torch, device)
        for value in values:
            if value.device.type != device or value.dtype != dtype or not bool(torch.isfinite(value).all()):
                raise RuntimeError("GPU operations did not preserve model precision or finite values")


def probe_fourier_audio(torch, device: str) -> None:
    with torch.inference_mode():
        audio = torch.randn(1024, device=device, dtype=torch.float32)
        window = torch.hann_window(256, device=device)
        spectrum = torch.stft(audio, 256, hop_length=64, window=window, return_complex=True)
        restored = torch.istft(spectrum, 256, hop_length=64, window=window, length=1024)
        synchronize(torch, device)
        if restored.device.type != device or not bool(torch.isfinite(restored).all()):
            raise RuntimeError("GPU Fourier audio processing returned invalid values")


def probe_decoder(torch, device: str, dtype) -> None:
    # Inspect the actual loaded decoder dtype. It need not equal the talker's
    # BF16 contract, and an unsupported decoder must not disable GPU attention.
    with torch.inference_mode():
        audio = torch.randn(1, 4, 16, device=device, dtype=dtype)
        values = [torch.nn.Conv1d(4, 8, 3, padding=1).to(device=device, dtype=dtype)(audio),
                  torch.nn.ConvTranspose1d(4, 8, 3, stride=2).to(device=device, dtype=dtype)(audio)]
        synchronize(torch, device)
        if any(value.device.type != device or value.dtype != dtype or not bool(torch.isfinite(value).all())
               for value in values):
            raise RuntimeError("GPU waveform decoding did not preserve precision or finite values")


def require_module_device(module, device: str, *, dtype=None) -> None:
    parameters = list(module.parameters())
    if not parameters:
        raise RuntimeError("The speech model has no loaded parameters")
    if any(parameter.device.type != device for parameter in parameters):
        raise RuntimeError("The speech model was not fully loaded on the selected GPU")
    if dtype is not None and any(parameter.is_floating_point() and parameter.dtype != dtype for parameter in parameters):
        raise RuntimeError("The speech model did not retain its required precision")


def move_decoder_to_cpu(runtime, tokenizer, torch, device: str, config: dict, reason: str,
                        *, report: bool = True) -> None:
    dtypes = [parameter.dtype for parameter in tokenizer.model.parameters()]
    tokenizer.model.to(device="cpu")
    tokenizer.device = torch.device("cpu")
    if hasattr(tokenizer.model, "hf_device_map"):
        tokenizer.model.hf_device_map = {"": "cpu"}
    require_module_device(tokenizer.model, "cpu")
    if tokenizer.model.device.type != "cpu" or tokenizer.device.type != "cpu":
        raise RuntimeError("The audio decoder did not move to CPU")
    if dtypes != [parameter.dtype for parameter in tokenizer.model.parameters()]:
        raise RuntimeError("The audio decoder changed precision while moving to CPU")
    if report:
        report_audio_cpu(runtime, device, config, reason)


def decoder_relative_error(accelerated, reference, sample_rate: int, np, *, allow_silence=False) -> float:
    """Compare identical audio codes, not independently sampled utterances.

    This verifies decoder math, not whether spoken words match the subtitle.
    CPU output remains the reference if accelerated decoding is corrupt.
    """
    if reference[1] != sample_rate or len(reference[0]) != 1:
        raise RuntimeError("The reference audio decoder returned an unexpected format")
    expected = np.asarray(reference[0][0], dtype=np.float64)
    if expected.ndim != 1 or not expected.size or not np.isfinite(expected).all():
        raise RuntimeError("The reference audio decoder returned invalid samples")
    reference_rms = float(np.sqrt(np.mean(expected * expected)))
    if reference_rms < 1e-5 and not allow_silence:
        raise RuntimeError("The reference audio decoder returned silent audio")
    if accelerated[1] != sample_rate or len(accelerated[0]) != 1:
        return float("inf")
    observed = np.asarray(accelerated[0][0], dtype=np.float64)
    if observed.shape != expected.shape or not np.isfinite(observed).all():
        return float("inf")
    return float(np.sqrt(np.mean((observed - expected) ** 2))) / max(reference_rms, 1e-6)


def decoder_probe_codes(encoded):
    # CustomVoice passes one [frames, 16] code tensor for each subtitle chunk.
    # 24 codec frames are 1.92 seconds; keep CPU verification bounded even for
    # long subtitles. This causal decoder reconstructs the same prefix when
    # supplied with the complete sequence.
    if not isinstance(encoded, list) or len(encoded) != 1 or not isinstance(encoded[0], dict):
        raise RuntimeError("The speech generator returned unexpected audio codes")
    codes = encoded[0].get("audio_codes")
    if codes is None or codes.ndim != 2 or codes.shape[0] < 1 or codes.shape[1] != 16:
        raise RuntimeError("The speech generator returned unexpected audio code dimensions")
    return [{"audio_codes": codes[:24]}]


def guard_qwen_decoder(runtime, config, tokenizer, torch, np, device: str) -> None:
    """Verify GPU waveform reconstruction and retry only that stage if needed.

    A small random convolution probe cannot catch shape-dependent corruption
    in the loaded decoder. Each generated chunk is decoded from the same
    code prefix on CPU for a numerical comparison. This adds bounded decoder work, but
    avoids rerunning the much larger autoregressive model on CPU and never
    substitutes a newly sampled utterance for the original one.
    """
    original_decode = tokenizer.decode

    def checked_decode(encoded):
        if tokenizer.device.type == "cpu":
            return original_decode(encoded)
        probe_codes = decoder_probe_codes(encoded)
        accelerated, failure = None, None
        try:
            accelerated = original_decode(encoded)
            synchronize(torch, device)
        except Exception as error:
            failure = safe_reason(error)
        runtime.stage("decoder-check", engine="qwen3", device=device, reference="cpu")
        move_decoder_to_cpu(runtime, tokenizer, torch, device, config, "Audio decoder verification", report=False)
        reference = original_decode(probe_codes)
        observed = accelerated
        if accelerated is not None and len(accelerated[0]) == 1 and len(reference[0]) == 1:
            observed = ([accelerated[0][0][:len(reference[0][0])]], accelerated[1])
        # A pause at the beginning is legitimate; this is a numerical probe,
        # while the complete output is checked for audible energy afterwards.
        relative_error = decoder_relative_error(
            reference if observed is None else observed, reference, runtime.SAMPLE_RATE, np, allow_silence=True)
        if failure is None and relative_error > 0.1:
            failure = f"Audio decoder differs from CPU reference (relative RMS error {relative_error:.4f})"
        if failure is not None:
            report_audio_cpu(runtime, device, config, failure)
            runtime.stage("decoder-check", engine="qwen3", device="cpu", status="recovered")
            return original_decode(encoded)
        try:
            dtypes = [parameter.dtype for parameter in tokenizer.model.parameters()]
            tokenizer.model.to(device=device)
            tokenizer.device = torch.device(device)
            if hasattr(tokenizer.model, "hf_device_map"):
                tokenizer.model.hf_device_map = {"": device}
            require_module_device(tokenizer.model, device)
            if dtypes != [parameter.dtype for parameter in tokenizer.model.parameters()]:
                raise RuntimeError("The audio decoder changed precision after verification")
        except Exception as error:
            move_decoder_to_cpu(runtime, tokenizer, torch, device, config, safe_reason(error))
            return original_decode(encoded)
        runtime.stage("decoder-check", engine="qwen3", device=device, status="passed",
                      relative_rms_error=f"{relative_error:.6f}")
        return accelerated

    tokenizer.decode = checked_decode


def generate_f5(runtime, config, root, text, speed, torch, np, sf, device):
    audio_device = device
    try:
        probe_fourier_audio(torch, device)
    except Exception as error:
        # The transformer does not need complex arithmetic. Keep its costly
        # inference on the GPU when the backend lacks Fourier audio support.
        audio_device = "cpu"
        report_audio_cpu(runtime, device, config, safe_reason(error))
    DiT, CFM, convert_char_to_pinyin, get_tokenizer, load_file, Vocos = runtime.import_f5()
    vocabulary, count = get_tokenizer(str(runtime.local_path(root, config["vocabulary"])), "custom")
    model = CFM(
        transformer=DiT(dim=1024, depth=22, heads=16, ff_mult=2, text_dim=512,
            text_mask_padding=True, qk_norm=None, conv_layers=4, pe_attn_head=None,
            attn_backend="torch", attn_mask_enabled=False, checkpoint_activations=False,
            text_num_embeds=count, mel_dim=100),
        mel_spec_kwargs={"n_fft": 1024, "hop_length": 256, "win_length": 1024,
            "n_mel_channels": 100, "target_sample_rate": runtime.SAMPLE_RATE, "mel_spec_type": "vocos"},
        odeint_kwargs={"method": "euler"}, vocab_char_map=vocabulary,
    )
    weights = load_file(str(runtime.local_path(root, config["model"])), device="cpu")
    weights = {key.replace("ema_model.", ""): value for key, value in weights.items()
               if key not in ("initted", "step")}
    for key in ("mel_spec.mel_stft.mel_scale.fb", "mel_spec.mel_stft.spectrogram.window"):
        weights.pop(key, None)
    model.load_state_dict(weights, strict=True)
    del weights
    model.to(device=device, dtype=torch.float32).eval()
    if audio_device == "cpu":
        model.mel_spec.to(device="cpu", dtype=torch.float32)
    vocoder = Vocos.from_hparams(str(runtime.local_path(root, config["vocoderConfig"])))
    vocoder.load_state_dict(torch.load(str(runtime.local_path(root, config["vocoderModel"])),
                                      map_location="cpu", weights_only=True))
    vocoder.to(device=audio_device, dtype=torch.float32).eval()
    require_module_device(model, device, dtype=torch.float32)
    require_module_device(vocoder, audio_device, dtype=torch.float32)
    reference, sample_rate = sf.read(runtime.local_path(root, config["referenceAudio"]), dtype="float32")
    if sample_rate != runtime.SAMPLE_RATE or reference.ndim != 1 or not 1 <= len(reference) / sample_rate <= 15:
        raise ValueError("Invalid local reference audio")
    reference = runtime.checked_audio(reference, np)
    reference_text = runtime.read_text(runtime.local_path(root, config["referenceText"]))
    audio = torch.from_numpy(reference).unsqueeze(0).to(device=audio_device, dtype=torch.float32)
    reference_rms = torch.sqrt(torch.mean(audio.square()))
    quiet_reference = bool(reference_rms < 0.1)
    if quiet_reference:
        audio = audio * 0.1 / reference_rms
    reference_frames = audio.shape[-1] // 256
    if audio_device == "cpu":
        # CFM.sample explicitly accepts a 3D mel condition and skips its own
        # waveform FFT in that case. Text, noise and ODE steps remain on GPU.
        with torch.inference_mode():
            audio = model.mel_spec(audio).permute(0, 2, 1).to(device=device, dtype=torch.float32)
    reference_bytes = len(reference_text.encode("utf-8"))
    max_bytes = max(4, int(reference_bytes / (len(reference) / sample_rate)
                           * (22 - len(reference) / sample_rate) * min(speed, 1.0)))
    chunks = runtime.split_text(text, max_bytes)
    runtime.stage("generating", engine="f5", device=device, dtype="float32", chunks=len(chunks))
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
            if generated.device.type != device:
                raise RuntimeError("The speech model returned output from an unexpected device")
            mel = generated[:, reference_frames:, :].float().permute(0, 2, 1).to(device=audio_device)
            wave = vocoder.decode(mel)
            if wave.device.type != audio_device:
                raise RuntimeError("The vocoder returned output from an unexpected device")
            if quiet_reference:
                wave = wave * reference_rms / 0.1
            samples = runtime.checked_audio(wave.squeeze().cpu().numpy(), np)
        parts.append(samples)
        sample_count += len(samples)
        runtime.progress(sample_count, index + 1, len(chunks))
    return runtime.join_audio(parts, 0.15, np)


def load_qwen_model(runtime, config, root, torch, device):
    from qwen_tts import Qwen3TTSModel
    attention = qwen_attention_implementation(device)
    model = Qwen3TTSModel.from_pretrained(
        str(runtime.local_path(root, config["model"], directory=True)),
        device_map=device, dtype=torch.bfloat16, attn_implementation=attention,
        local_files_only=True, low_cpu_mem_usage=True)
    if attention == "eager":
        tokenizer = getattr(model.model, "speech_tokenizer", None)
        tokenizer_model = getattr(tokenizer, "model", None)
        decoder = getattr(tokenizer_model, "decoder", None)
        if decoder is None:
            raise RuntimeError("The speech audio decoder was not loaded")
        # The model loader consumes attn_implementation before loading its
        # independent tokenizer. CustomVoice uses only its audio decoder;
        # configure that dynamic-attention component explicitly as well.
        for component in (model.model, decoder):
            component.set_attn_implementation("eager")
            layers = [layer for layer in component.modules()
                      if hasattr(layer, "num_key_value_groups") and hasattr(layer, "q_proj")]
            if not layers or any(getattr(layer.config, "_attn_implementation", None) != "eager" for layer in layers):
                raise RuntimeError("The speech model did not apply explicit grouped attention")
    runtime.stage("attention", engine="qwen3", device=device, implementation=attention)
    return model


def generate_qwen(runtime, config, root, text, speed, torch, np, device):
    model = load_qwen_model(runtime, config, root, torch, device)
    talker = getattr(model.model, "talker", None)
    tokenizer = getattr(model.model, "speech_tokenizer", None)
    if talker is None or tokenizer is None or getattr(tokenizer, "model", None) is None:
        raise RuntimeError("The speech model or audio decoder was not loaded")
    # The decoder may intentionally contain FP32 modules; only the talker has
    # a BF16 precision contract. Both complete models must reside on the GPU.
    require_module_device(model.model, device)
    require_module_device(talker, device, dtype=torch.bfloat16)
    require_module_device(tokenizer.model, device)
    if model.device.type != device or tokenizer.device.type != device:
        raise RuntimeError("The speech model and audio decoder disagree on the inference device")
    try:
        probe_decoder(torch, device, next(tokenizer.model.parameters()).dtype)
    except Exception as error:
        # Qwen's tokenizer.decode moves audio codes to its own device before
        # decoding. Moving that module explicitly preserves GPU generation and
        # keeps the decoder's loaded precision unchanged.
        move_decoder_to_cpu(runtime, tokenizer, torch, device, config, safe_reason(error))
    guard_qwen_decoder(runtime, config, tokenizer, torch, np, device)
    original_generate = talker.generate
    eos_token_id = model.model.config.talker_config.codec_eos_token_id

    def generate_until_end(*args, **kwargs):
        result = original_generate(*args, **kwargs)
        runtime.verify_generation_stop(result.sequences, eos_token_id)
        return result

    talker.generate = generate_until_end
    chunks = runtime.split_text(text, 300)
    runtime.stage("generating", engine="qwen3", device=device, dtype="bfloat16", chunks=len(chunks))
    parts, sample_count = [], 0
    for index, chunk in enumerate(chunks):
        torch.manual_seed(config["seed"] + index)
        np.random.seed(config["seed"] + index)
        with torch.inference_mode():
            waves, sample_rate = model.generate_custom_voice(
                text=chunk, language=config["language"], speaker=config["speaker"],
                instruct=config["instruct"], non_streaming_mode=True,
                do_sample=True, temperature=0.9, top_p=1.0, top_k=50,
                repetition_penalty=1.05, subtalker_dosample=True, subtalker_temperature=0.9,
                subtalker_top_p=1.0, subtalker_top_k=50, max_new_tokens=2048)
        if sample_rate != runtime.SAMPLE_RATE or len(waves) != 1:
            raise RuntimeError("Unexpected generated audio format")
        samples = runtime.checked_audio(waves[0], np)
        if speed != 1:
            import librosa
            samples = runtime.checked_audio(librosa.effects.time_stretch(samples, rate=speed), np)
        parts.append(samples)
        sample_count += len(samples)
        runtime.progress(sample_count, index + 1, len(chunks))
    synchronize(torch, device)
    return runtime.join_audio(parts, 0.03, np)


def generate_cpu(runtime, config, root, text, speed, torch, np, sf):
    if config["engine"] == "f5":
        return runtime.generate_f5(config, root, text, speed, torch, np, sf)
    return runtime.generate_qwen(config, root, text, speed, torch, np)


def generate_gpu(runtime, config, root, text, speed, torch, np, sf, device):
    probe_device(torch, device, config["engine"])
    if config["engine"] == "f5":
        return generate_f5(runtime, config, root, text, speed, torch, np, sf, device)
    return generate_qwen(runtime, config, root, text, speed, torch, np, device)


def run(runtime, args) -> None:
    # The caller already configures the offline environment and invocation
    # cache. Validate input before allocating model memory or probing hardware.
    config, root = runtime.load_config(args.config)
    text = runtime.read_text(args.text_file)
    requested = getattr(args, "device", "auto")
    if requested not in DEVICES:
        raise ValueError("Unsupported speech inference device")
    if getattr(args, "self_test", False):
        raise ValueError("Application inference requires a text request")
    if config.get("engine") not in ("f5", "qwen3"):
        raise ValueError("Unsupported application speech engine")
    # Per-operator CPU fallback can turn a claimed GPU job into a slow mixed
    # job. Prefer one explicit, observable fallback of the complete request.
    os.environ.pop("PYTORCH_ENABLE_MPS_FALLBACK", None)
    runtime.stage("loading")
    import numpy as np
    import soundfile as sf
    import torch
    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(1)

    try:
        candidates = gpu_candidates(torch, requested)
    except Exception as error:
        # Driver discovery itself can fail before a backend is selected.
        # Invalid device names were rejected before importing inference code.
        reason = safe_reason(error)
        runtime.stage("fallback", **{"from": requested, "device": "cpu", "reason": reason})
        print(f"Speech GPU discovery failed; using CPU: {reason}", file=sys.stderr, flush=True)
        candidates = []
    device = candidates[0] if candidates else "cpu"
    report_device(runtime, device, config)
    if device == "cpu":
        wave = generate_cpu(runtime, config, root, text, args.speed, torch, np, sf)
    else:
        failure = None
        try:
            wave = generate_gpu(runtime, config, root, text, args.speed, torch, np, sf, device)
        except Exception as error:
            # BaseException (interrupt/exit/cancellation) deliberately bypasses
            # this branch. Keep no traceback/model references during cleanup.
            failure = safe_reason(error)
        finally:
            release_device(torch, device)
        if failure is not None:
            runtime.stage("fallback", **{"from": device, "device": "cpu", "reason": failure})
            print(f"Speech GPU attempt failed; retrying once on CPU: {failure}", file=sys.stderr, flush=True)
            device = "cpu"
            report_device(runtime, device, config)
            wave = generate_cpu(runtime, config, root, text, args.speed, torch, np, sf)

    # Disk or WAV-validation failure must not waste time repeating synthesis.
    runtime.stage("writing", device=device)
    report = runtime.write_audio(args.output_filename, wave, np, sf)
    runtime.stage("complete", engine=config["engine"], device=device, dtype=config["dtype"])
    import json
    print(json.dumps(report), flush=True)
