#!/usr/bin/env python3
"""Local image inference adapter. Model downloads and process recovery belong to the host."""

from __future__ import annotations

import argparse
import contextlib
import json
import math
import os
from pathlib import Path
import secrets
import struct
import sys
import time


MODELS = {
    "qwen-image": {"text-to-image": "QwenImagePipeline", "image-to-image": "QwenImageImg2ImgPipeline"},
    "z-image-turbo": {"text-to-image": "ZImagePipeline", "image-to-image": "ZImageImg2ImgPipeline"},
}
OUTPUT = sys.stdout


class MemoryPreflightError(RuntimeError):
    code = "INSUFFICIENT_PHYSICAL_MEMORY"


class WeightInspectionError(RuntimeError):
    code = "INVALID_WEIGHT_HEADER"


def emit(stage: str, **fields) -> None:
    print(json.dumps({"stage": stage, **fields}, ensure_ascii=False), file=OUTPUT, flush=True)


def integer(value, name: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ValueError(f"{name} must be an integer between {minimum} and {maximum}")
    return value


def number(value, name: str, minimum: float, maximum: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{name} must be a finite number")
    if not minimum <= value <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return float(value)


def absolute_path(value, name: str) -> Path:
    if not isinstance(value, str) or not value or not Path(value).is_absolute():
        raise ValueError(f"{name} must be an absolute local path")
    return Path(value).resolve()


def validate_request(request: dict) -> dict:
    if not isinstance(request, dict):
        raise ValueError("The request must be a JSON object")
    result = dict(request)
    for key in ("mode", "negativePrompt", "width", "height", "steps", "seed", "guidance", "strength", "device", "memoryMode"):
        if result.get(key) is None:
            result.pop(key, None)
    model = result.get("modelId")
    mode = result.get("mode", "text-to-image")
    if model not in MODELS or mode not in MODELS[model]:
        raise ValueError("Unsupported image model or generation mode")
    result["mode"] = mode
    prompt = result.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 6000:
        raise ValueError("prompt must contain between 1 and 6000 characters")
    negative = result.get("negativePrompt", "")
    if not isinstance(negative, str) or len(negative) > 6000:
        raise ValueError("negativePrompt must be text with at most 6000 characters")
    if model == "z-image-turbo" and negative.strip():
        raise ValueError("This model does not support negative prompts")
    result["negativePrompt"] = negative
    for field in ("width", "height"):
        result[field] = integer(result.get(field, 1024), field, 256, 2048)
        if result[field] % 16:
            raise ValueError(f"{field} must be a multiple of 16")
    result["steps"] = integer(result.get("steps", 9 if model == "z-image-turbo" else 50), "steps", 1, 100)
    result["seed"] = integer(result.get("seed", secrets.randbelow(2**32)), "seed", 0, 2**32 - 1)
    result["guidance"] = number(result.get("guidance", 0 if model == "z-image-turbo" else 4), "guidance", 0, 20)
    if model == "z-image-turbo" and result["guidance"] != 0:
        raise ValueError("This model requires guidance=0")
    result["strength"] = number(result.get("strength", 0.75), "strength", 0, 1)
    if mode == "image-to-image" and int(result["steps"] * result["strength"]) < 1:
        raise ValueError("Image-to-image strength must leave at least one denoising step")
    result["modelRoot"] = absolute_path(result.get("modelRoot"), "modelRoot")
    if not (result["modelRoot"] / "model_index.json").is_file():
        raise ValueError("The local model is incomplete: model_index.json is missing")
    result["outputPath"] = absolute_path(result.get("outputPath"), "outputPath")
    if result["outputPath"].suffix.lower() != ".png":
        raise ValueError("The output must be a PNG file")
    if result["outputPath"] == result["modelRoot"] or result["modelRoot"] in result["outputPath"].parents:
        raise ValueError("The output cannot overwrite model files")
    if result["outputPath"].exists():
        raise ValueError("The output already exists; choose a new output path")
    if mode == "image-to-image":
        result["inputImagePath"] = absolute_path(result.get("inputImagePath"), "inputImagePath")
        if not result["inputImagePath"].is_file():
            raise ValueError("The input image is missing")
    elif result.get("inputImagePath"):
        raise ValueError("An input image requires image-to-image mode")
    result["device"] = result.get("device", "auto")
    if result["device"] not in ("auto", "cuda", "mps", "cpu"):
        raise ValueError("Unsupported inference device")
    result["memoryMode"] = result.get("memoryMode", "low")
    if result["memoryMode"] not in ("low", "balanced"):
        raise ValueError("Unsupported memory mode")
    return result


def select_device(torch, requested: str) -> str:
    cuda = bool(torch.cuda.is_available())
    mps = bool(getattr(torch.backends, "mps", None) and torch.backends.mps.is_available())
    if requested == "auto":
        return "cuda" if cuda else "mps" if mps else "cpu"
    if requested == "cuda" and not cuda or requested == "mps" and not mps:
        raise RuntimeError(f"The requested {requested} accelerator is unavailable")
    return requested


def select_dtype(torch, device: str):
    if device == "cuda":
        return torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
    if device == "mps" and torch.backends.mps.is_macos_or_newer(14, 0):
        return torch.bfloat16
    return torch.float32


def pipeline_arguments(request: dict) -> dict:
    args = {
        "prompt": request["prompt"], "width": request["width"], "height": request["height"],
        "num_inference_steps": request["steps"], "output_type": "pil",
    }
    if request["modelId"] == "qwen-image":
        args["true_cfg_scale"] = request["guidance"]
        # This pipeline only enables classifier-free guidance when a negative prompt is supplied.
        args["negative_prompt"] = request["negativePrompt"] or " "
    else:
        args["guidance_scale"] = 0.0
    if request["mode"] == "image-to-image":
        args["strength"] = request["strength"]
    return args


def configure_memory(pipe, device: str, memory_mode: str) -> None:
    if hasattr(pipe.vae, "enable_tiling"):
        pipe.vae.enable_tiling()
    if device != "cpu" and memory_mode == "low":
        # Explicitly pass the selected accelerator; the library default can otherwise select CUDA.
        pipe.enable_sequential_cpu_offload(device=device)
    else:
        pipe.to(device)


def weight_memory_bytes(model_root: Path, floating_bytes: int) -> int:
    """Inspect tensor shapes without reading tensor payloads or constructing tensors."""
    integer_sizes = {"I64": 8, "U64": 8, "I32": 4, "U32": 4, "I16": 2, "U16": 2,
                     "I8": 1, "U8": 1, "BOOL": 1}
    floating_sizes = {"F64": 8, "F32": 4, "F16": 2, "BF16": 2,
                      "F8_E4M3": 1, "F8_E5M2": 1, "F8_E4M3FN": 1}
    files = sorted(path for component in ("text_encoder", "transformer", "vae")
                   for path in (model_root / component).glob("*.safetensors"))
    if not files:
        raise WeightInspectionError("本地模型缺少可校验的权重文件，已停止加载，请修复模型。")
    total = 0
    for path in files:
        try:
            with path.open("rb") as stream:
                length_bytes = stream.read(8)
                if len(length_bytes) != 8:
                    raise ValueError("truncated header length")
                length = struct.unpack("<Q", length_bytes)[0]
                file_size = os.fstat(stream.fileno()).st_size
                if not 2 <= length <= 16 * 1024 * 1024 or length > file_size - 8:
                    raise ValueError("invalid header length")
                header = json.loads(stream.read(length))
            if not isinstance(header, dict):
                raise ValueError("invalid tensor table")
            for name, tensor in header.items():
                if name == "__metadata__":
                    continue
                if not isinstance(tensor, dict) or tensor.get("dtype") not in integer_sizes | floating_sizes:
                    raise ValueError("unknown tensor dtype")
                shape = tensor.get("shape")
                if not isinstance(shape, list) or any(isinstance(size, bool) or not isinstance(size, int) or size < 0 for size in shape):
                    raise ValueError("invalid tensor shape")
                count = math.prod(shape)
                dtype = tensor["dtype"]
                storage_bytes = count * (integer_sizes | floating_sizes)[dtype]
                offsets = tensor.get("data_offsets")
                if (not isinstance(offsets, list) or len(offsets) != 2
                        or any(isinstance(offset, bool) or not isinstance(offset, int) for offset in offsets)
                        or offsets[0] < 0 or offsets[1] - offsets[0] != storage_bytes
                        or offsets[1] > file_size - 8 - length):
                    raise ValueError("invalid tensor data range")
                total += count * (floating_bytes if dtype in floating_sizes else integer_sizes[dtype])
        except (OSError, ValueError, TypeError, OverflowError) as error:
            raise WeightInspectionError(f"模型权重头部校验失败（{path.name}），已停止加载，请修复模型。") from error
    if total <= 0:
        raise WeightInspectionError("模型权重为空，已停止加载，请修复模型。")
    return total


def physical_memory_bytes() -> int | None:
    try:
        import psutil
        value = int(psutil.virtual_memory().total)
        return value if value > 0 else None
    except (ImportError, OSError, ValueError, AttributeError):
        # The portable runtime includes psutil. This fallback also allows standalone Linux diagnostics.
        try:
            value = int(os.sysconf("SC_PHYS_PAGES")) * int(os.sysconf("SC_PAGE_SIZE"))
            return value if value > 0 else None
        except (OSError, ValueError, AttributeError):
            return None


def memory_preflight(model_root: Path, device: str, floating_bytes: int) -> None:
    if device not in ("cpu", "mps"):
        return
    required = weight_memory_bytes(model_root, floating_bytes)
    physical = physical_memory_bytes()
    emit("preflight", device=device, weightBytes=required, physicalMemoryBytes=physical,
         estimateScope="weights-only; excludes activations and application memory")
    if physical is not None and required > physical:
        needed_gib, physical_gib = required / 1024**3, physical / 1024**3
        if device == "cpu":
            raise MemoryPreflightError(
                f"CPU 全精度权重最低需要 {needed_gib:.1f} GiB，本机物理内存为 {physical_gib:.1f} GiB。"
                "已停止 CPU 加载，避免大量分页造成界面失去响应；请改用较小模型或内存更充足的设备。"
                "该估算仅包含权重，不含生成中间结果。")
        emit("preflight", device=device,
             warning=f"当前精度权重约 {needed_gib:.1f} GiB，超过本机 {physical_gib:.1f} GiB 物理内存。"
                     "按层卸载和文件映射可能降低驻留量，但无法保证完成，分页可能非常缓慢；失败后不会尝试超出物理内存的 CPU 全精度加载。")
    elif physical is None:
        emit("preflight", device=device, warning="无法读取物理内存大小；仅权重内存估算已返回，实际还需要生成中间结果空间。")


def run(request: dict) -> None:
    # Set before importing the inference libraries. No model or remote code is fetched by this adapter.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    os.environ["PYTORCH_ENABLE_MPS_FALLBACK"] = "1"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    start = time.monotonic()
    emit("loading")
    import torch
    import diffusers
    from PIL import Image, ImageOps

    device = select_device(torch, request["device"])
    dtype = select_dtype(torch, device)
    emit("loading", device=device, dtype=str(dtype).replace("torch.", ""), memoryMode=request["memoryMode"])
    memory_preflight(request["modelRoot"], device, 4 if dtype == torch.float32 else 2)
    if device == "cpu":
        emit("loading", device=device, warning="正在使用 CPU；完整精度推理可能需要较大内存并耗时较长。")
    elif request["memoryMode"] == "low":
        emit("loading", device=device, warning="按层传输权重以降低加速器内存压力；系统内存仍需容纳完整模型。")
    pipeline_type = getattr(diffusers, MODELS[request["modelId"]][request["mode"]])
    pipe = pipeline_type.from_pretrained(
        str(request["modelRoot"]), torch_dtype=dtype, local_files_only=True,
        use_safetensors=True, low_cpu_mem_usage=True,
    )
    pipe.set_progress_bar_config(disable=True)
    configure_memory(pipe, device, request["memoryMode"])
    args = pipeline_arguments(request)
    if request["mode"] == "image-to-image":
        with Image.open(request["inputImagePath"]) as source:
            args["image"] = ImageOps.exif_transpose(source).convert("RGB")
    # A CPU generator is supported by the pipelines on all devices, including MPS.
    args["generator"] = torch.Generator(device="cpu").manual_seed(request["seed"])

    def completed_step(pipeline, index, _timestep, callback_kwargs):
        total = int(pipeline.num_timesteps)
        done = index + 1
        emit("denoising", device=device, step=done, totalSteps=total,
             progress=min(done / total, 1.0) if total else None,
             elapsedSeconds=round(time.monotonic() - start, 3))
        return callback_kwargs

    args["callback_on_step_end"] = completed_step
    emit("encoding", device=device, seed=request["seed"])
    with torch.inference_mode():
        result = pipe(**args)
    if not result.images:
        raise RuntimeError("The model returned no image")
    image = result.images[0]
    emit("saving", device=device)
    output = request["outputPath"]
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(output.name + f".{os.getpid()}.partial")
    try:
        image.save(temporary, format="PNG")
        # Reading the completed file verifies it before it becomes visible to other workspaces.
        with Image.open(temporary) as verified:
            verified.verify()
        os.replace(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)
    emit("complete", progress=1, outputPath=str(output), width=image.width, height=image.height,
         seed=request["seed"], device=device, elapsedSeconds=round(time.monotonic() - start, 3))


def main() -> int:
    # Isolated Python ignores PYTHONIOENCODING; the host protocol is UTF-8 on every platform.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True, type=Path)
    parser.add_argument("--validate-only", action="store_true")
    arguments = parser.parse_args()
    try:
        if arguments.request.stat().st_size > 1_000_000:
            raise ValueError("The request is too large")
        request = validate_request(json.loads(arguments.request.read_text(encoding="utf-8")))
        if arguments.validate_only:
            emit("validated", modelId=request["modelId"], mode=request["mode"], seed=request["seed"])
        else:
            # Third-party diagnostic prints must not corrupt the host's JSON-line protocol.
            with contextlib.redirect_stdout(sys.stderr):
                run(request)
        return 0
    except Exception as error:
        if isinstance(error, (MemoryPreflightError, WeightInspectionError)):
            emit("preflight", error=str(error), errorType=type(error).__name__, code=error.code)
        print(json.dumps({"stage": "error", "error": str(error), "errorType": type(error).__name__},
                         ensure_ascii=False), file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
