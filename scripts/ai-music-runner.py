#!/usr/bin/env python3
"""Offline music inference for the application's separately installed AI runtime.

The reviewed engine source is pinned in the runtime lock. Only model weights and
configuration are read from the download directory; model-provided Python is
never imported. See licenses/ai-generation/music/NOTICE.md for integration notes.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import math
import os
from pathlib import Path
import sys
import tempfile


SOURCE_REVISION = "ca1e85fe9430179831e6bc6be790c332190a3866"
MODEL_VARIANTS = {
    "ace-step-1.5-turbo": ("acestep-v15-turbo", "turbo", 8),
    "ace-step-1.5-sft": ("acestep-v15-sft", "sft", 50),
}
EVENT_STREAM = sys.stdout


def emit(stage: str, **fields) -> None:
    print(json.dumps({"stage": stage, **fields}, ensure_ascii=False), file=EVENT_STREAM, flush=True)


def number(value, name: str, low: float, high: float, default, integer: bool = False):
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{name}必须是有效数字")
    if value < low or value > high or (integer and int(value) != value):
        raise ValueError(f"{name}范围为 {low:g}–{high:g}")
    return int(value) if integer else float(value)


def text(value, name: str, limit: int, default: str = "") -> str:
    if value is None:
        return default
    if not isinstance(value, str) or "\0" in value or len(value) > limit:
        raise ValueError(f"{name}必须为不超过 {limit} 个字符的文本")
    return value.strip()


def validate_request(raw: dict) -> dict:
    if not isinstance(raw, dict):
        raise ValueError("生成请求必须为对象")
    raw = {key: value for key, value in raw.items() if value is not None}
    model_id = raw.get("modelId")
    if model_id not in MODEL_VARIANTS:
        raise ValueError("未知音乐模型，请重新安装受支持的模型")
    variant, _, default_steps = MODEL_VARIANTS[model_id]
    prompt = text(raw.get("prompt"), "提示词", 4096)
    if not prompt:
        raise ValueError("请输入音乐风格或场景描述")
    lyrics = text(raw.get("lyrics"), "歌词", 6000)
    instrumental = raw.get("instrumental")
    if instrumental is None:
        instrumental = not bool(lyrics)
    if not isinstance(instrumental, bool):
        raise ValueError("纯音乐选项必须为布尔值")
    if not instrumental and not lyrics:
        raise ValueError("歌曲模式需要填写歌词")
    if instrumental and lyrics and lyrics.lower() != "[instrumental]":
        raise ValueError("纯音乐模式不使用歌词，请清空歌词或切换为歌曲模式")
    if text(raw.get("negativePrompt"), "负面提示词", 4096):
        raise ValueError("此音乐模型不支持负面提示词")
    if raw.get("inputAsset") or raw.get("inputPath"):
        raise ValueError("当前音乐生成支持提示词与歌词，暂不支持音频输入")
    guidance = number(raw.get("guidance"), "提示词强度", 0, 30,
                      1.0 if variant == "acestep-v15-turbo" else 7.0)
    if variant == "acestep-v15-turbo" and guidance != 1:
        raise ValueError("快速音乐模型的提示词强度固定为 1")
    device = raw.get("device", "auto")
    if device not in ("auto", "cuda", "mps", "cpu"):
        raise ValueError("不支持的推理设备")
    model_root = Path(text(raw.get("modelRoot"), "模型目录", 32768)).expanduser()
    output_path = Path(text(raw.get("outputPath"), "输出路径", 32768)).expanduser()
    if not model_root.is_absolute() or not model_root.is_dir():
        raise ValueError("模型目录不存在或不是绝对路径，请先下载模型")
    if not output_path.is_absolute() or output_path.suffix.lower() != ".wav":
        raise ValueError("输出必须为绝对路径的 WAV 文件")
    output_path = output_path.resolve()
    if output_path.is_relative_to(model_root.resolve()):
        raise ValueError("不能将生成结果写入模型目录")
    if output_path.exists():
        raise ValueError("输出文件已存在，请使用新的输出路径")
    memory_mode = raw.get("memoryMode", "low" if raw.get("lowMemory", True) else "balanced")
    if memory_mode not in ("low", "balanced"):
        raise ValueError("不支持的内存模式")
    language = text(raw.get("language"), "歌词语言", 20, "unknown") or "unknown"
    return {
        "modelId": model_id, "variant": variant,
        "modelRoot": model_root.resolve(), "outputPath": output_path,
        "prompt": prompt, "lyrics": "[Instrumental]" if instrumental else lyrics,
        "instrumental": instrumental, "device": device, "memoryMode": memory_mode,
        "seconds": number(raw.get("seconds"), "时长", 10, 600, 30.0),
        "steps": number(raw.get("steps"), "采样步数", 1, 100, default_steps, True),
        "guidance": guidance,
        "seed": number(raw.get("seed"), "随机种子", 0, 2**32 - 1, None, True),
        "bpm": number(raw.get("bpm"), "每分钟节拍数", 30, 300, None, True),
        "language": language, "keyScale": text(raw.get("keyScale"), "调式", 64),
    }


def required_files(variant: str) -> tuple[str, ...]:
    return (
        f"{variant}/config.json", f"{variant}/model.safetensors", f"{variant}/silence_latent.pt",
        "vae/config.json", "vae/diffusion_pytorch_model.safetensors",
        "Qwen3-Embedding-0.6B/config.json", "Qwen3-Embedding-0.6B/model.safetensors",
        "Qwen3-Embedding-0.6B/tokenizer.json", "Qwen3-Embedding-0.6B/tokenizer_config.json",
    )


def verify_local_layout(root: Path, variant: str) -> None:
    # Compare canonical paths on both sides: temporary/model directories can
    # use filesystem aliases, including shortened or redirected system paths.
    root = root.resolve()
    for relative in required_files(variant):
        candidate = (root / relative).resolve()
        if not candidate.is_relative_to(root) or not candidate.is_file() or candidate.stat().st_size == 0:
            raise ValueError(f"模型文件缺失或无效：{relative}。请在模型管理中修复下载。")


def configure_offline(root: Path, cache: Path) -> None:
    os.environ.update({
        "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "HF_DATASETS_OFFLINE": "1",
        "HF_HUB_DISABLE_TELEMETRY": "1", "DO_NOT_TRACK": "1", "TOKENIZERS_PARALLELISM": "false",
        "ACESTEP_CHECKPOINTS_DIR": str(root), "ACESTEP_PROJECT_ROOT": str(cache),
        "HF_HOME": str(cache / "huggingface"), "ACESTEP_GENERATION_TIMEOUT": "7200",
    })


def verify_runtime_source(executable: Path) -> None:
    for ancestor in executable.resolve().parents:
        marker = ancestor / "licenses/music-source/source.json"
        if marker.is_file():
            source = json.loads(marker.read_text(encoding="utf-8"))
            if source.get("revision") != SOURCE_REVISION:
                raise RuntimeError("音乐运行环境版本不匹配，请在模型管理中更新运行环境")
            return
    raise RuntimeError("未找到音乐运行环境的版本记录，请在模型管理中重新安装运行环境")


def choose_device(torch, requested: str) -> str:
    cuda = torch.cuda.is_available()
    mps = bool(getattr(torch.backends, "mps", None) and torch.backends.mps.is_available())
    if requested == "auto":
        return "cuda" if cuda else "mps" if mps else "cpu"
    if requested == "cuda" and not cuda:
        raise RuntimeError("CUDA 不可用，无法在指定 GPU 上生成")
    if requested == "mps" and not mps:
        raise RuntimeError("Apple GPU 不可用，无法在指定 GPU 上生成")
    return requested


def make_offline_handler(torch, request: dict):
    from acestep.handler import AceStepHandler
    from acestep.models.common.configuration_acestep_v15 import AceStepConfig

    if request["variant"] == "acestep-v15-turbo":
        from acestep.models.turbo.modeling_acestep_v15_turbo import AceStepConditionGenerationModel
    else:
        from acestep.models.sft.modeling_acestep_v15_base import AceStepConditionGenerationModel

    class OfflineMusicHandler(AceStepHandler):
        # The upstream precheck downloads an unrelated language-planning model
        # when absent. This adapter instead checks our explicit local manifest.
        def _ensure_models_present(self, *, checkpoint_path, config_path, **_kwargs):
            verify_local_layout(Path(checkpoint_path).resolve(), config_path)
            return None

        @staticmethod
        def _sync_model_code_if_needed(*_args, **_kwargs):
            # Classes come from the reviewed runtime, never the weights folder.
            return None

        def _initialize_mlx_backends(self, **_kwargs):
            self.mlx_decoder = self.mlx_vae = None
            self.use_mlx_dit = self.use_mlx_vae = False
            return "Disabled", "Disabled"

        def _start_diffusion_progress_estimator(self, **_kwargs):
            # Actual decoder calls provide progress; do not report timer guesses.
            return None, None

        def _load_main_model_from_checkpoint(self, *, model_checkpoint_path, device, **_kwargs):
            config = AceStepConfig.from_pretrained(model_checkpoint_path, local_files_only=True)
            attention = "sdpa"
            if device == "cuda" and not torch.cuda.is_bf16_supported():
                attention = "eager"
            self.model = AceStepConditionGenerationModel.from_pretrained(
                model_checkpoint_path, config=config, local_files_only=True,
                use_safetensors=True, attn_implementation=attention, dtype=self.dtype,
            )
            self.model.config._attn_implementation = attention
            self.config = self.model.config
            self._sync_alignment_config()
            self._apply_cuda_bool_argsort_workaround()
            target = "cpu" if self.offload_to_cpu and self.offload_dit_to_cpu else device
            self.model = self.model.to(target).to(self.dtype).eval()
            self.silence_latent = torch.load(
                str(Path(model_checkpoint_path) / "silence_latent.pt"),
                weights_only=True, map_location="cpu",
            ).transpose(1, 2).to(target).to(self.dtype)
            return attention

    return OfflineMusicHandler()


def generate(request: dict) -> None:
    verify_local_layout(request["modelRoot"], request["variant"])
    output = request["outputPath"]
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".music-generation-", dir=output.parent) as temporary:
        cache = Path(temporary)
        configure_offline(request["modelRoot"], cache)
        verify_runtime_source(Path(sys.executable))
        emit("loading", detail="正在载入音乐生成运行环境")
        import torch
        import soundfile as sf
        import numpy as np
        from acestep.inference import GenerationParams, GenerationConfig, generate_music

        device = choose_device(torch, request["device"])
        emit("loading", detail="正在载入本地音乐模型", device=device)
        handler = make_offline_handler(torch, request)
        low_memory = request["memoryMode"] == "low" and device != "cpu"
        status, ready = handler.initialize_service(
            project_root=str(cache), config_path=request["variant"], device=device,
            use_flash_attention=False, compile_model=False, quantization=None,
            offload_to_cpu=low_memory, offload_dit_to_cpu=low_memory, use_mlx_dit=False,
        )
        if not ready:
            raise RuntimeError(status)
        # Explicit device requests must not silently change the selected backend.
        if str(handler.device).split(":", 1)[0] != device:
            raise RuntimeError(f"运行环境未使用指定设备：{device}")
        seed = request["seed"]
        if seed is None:
            import secrets
            seed = secrets.randbelow(2**32)
        params = GenerationParams(
            task_type="text2music", caption=request["prompt"], lyrics=request["lyrics"],
            instrumental=request["instrumental"], duration=request["seconds"], bpm=request["bpm"],
            vocal_language=request["language"], keyscale=request["keyScale"],
            inference_steps=request["steps"], seed=seed,
            guidance_scale=1.0 if request["variant"] == "acestep-v15-turbo" else request["guidance"],
            thinking=False, use_cot_caption=False, use_cot_language=False, use_cot_metas=False,
            use_cot_lyrics=False, infer_method="ode", sampler_mode="euler", dcw_enabled=False,
            enable_normalization=True,
        )
        config = GenerationConfig(batch_size=1, audio_format="wav", use_random_seed=False, seeds=[seed])
        completed = 0

        def decoder_finished(_module, _inputs, _outputs):
            nonlocal completed
            completed += 1
            emit("generating", progress=min(0.85, 0.15 + 0.70 * completed / request["steps"]),
                 detail=f"正在生成音乐 {min(completed, request['steps'])}/{request['steps']}", device=device)

        def progress(value, desc="", **_kwargs):
            if value >= 0.99:
                emit("saving", detail="正在保存生成的音频", progress=0.97)
            elif value >= 0.8:
                emit("decoding", detail="正在解码音频", progress=0.88)
            elif value <= 0.52:
                emit("generating", detail="正在编码提示词与歌词", progress=0.15)

        hook = handler.model.decoder.register_forward_hook(decoder_finished)
        try:
            result = generate_music(handler, None, params, config, save_dir=str(cache / "output"), progress=progress)
        finally:
            hook.remove()
        if not result.success or not result.audios:
            raise RuntimeError(result.error or "模型未返回有效音频")
        generated = Path(result.audios[0]["path"]).resolve()
        if not generated.is_relative_to(cache.resolve()) or not generated.is_file():
            raise RuntimeError("生成结果路径无效")
        audio, sample_rate = sf.read(str(generated), dtype="float32", always_2d=True)
        if audio.size == 0 or sample_rate < 8000 or not np.isfinite(audio).all():
            raise RuntimeError("生成音频为空或包含无效数值")
        duration = len(audio) / sample_rate
        if duration < max(1.0, request["seconds"] * 0.5):
            raise RuntimeError("生成音频未达到请求时长，请重试")
        peak = float(np.max(np.abs(audio)))
        if peak < 1e-7:
            raise RuntimeError("生成结果为静音，请调整提示词或随机种子重试")
        # Write standard PCM so every editor playback and export path can read it.
        staged = cache / "validated.wav"
        sf.write(str(staged), audio, sample_rate, subtype="PCM_16", format="WAV")
        os.replace(staged, output)
        emit("completed", progress=1, outputPath=str(output), device=device, seed=seed,
             seconds=duration, sampleRate=sample_rate)


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.request.stat().st_size > 1_048_576:
            raise ValueError("生成请求过大")
        request = validate_request(json.loads(args.request.read_text(encoding="utf-8")))
        # Dependency logs are diagnostic stderr; stdout is solely the job protocol.
        with contextlib.redirect_stdout(sys.stderr):
            generate(request)
        return 0
    except Exception as error:
        emit("failed", error=str(error), detail="音乐生成失败")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
