#!/usr/bin/env python3
"""Offline import and small-compute validation; never a model quality test."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import socket
import tempfile


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true", required=True)
    parser.add_argument("--require-gpu", action="store_true")
    args = parser.parse_args()

    def blocked(*_args, **_kwargs):
        raise RuntimeError("Network access is disabled during runtime validation")

    socket.socket.connect = blocked
    socket.socket.connect_ex = blocked
    socket.create_connection = blocked
    socket.getaddrinfo = blocked
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1",
                      PYTORCH_ENABLE_MPS_FALLBACK="1", TOKENIZERS_PARALLELISM="false")
    import torch
    import torchaudio
    import torchvision
    import diffusers
    import transformers
    import safetensors
    import soundfile
    from diffusers import QwenImagePipeline, QwenImageImg2ImgPipeline, ZImagePipeline, ZImageImg2ImgPipeline
    from acestep.handler import AceStepHandler
    from acestep.inference import generate_music
    from acestep.models.common.configuration_acestep_v15 import AceStepConfig
    from acestep.models.turbo.modeling_acestep_v15_turbo import AceStepConditionGenerationModel as TurboModel
    from acestep.models.sft.modeling_acestep_v15_sft import AceStepConditionGenerationModel as StandardModel
    from PIL import Image

    assert torch.__version__.split("+")[0] == "2.9.1"
    assert diffusers.__version__ == "0.39.0"
    assert transformers.__version__ == "4.57.3"
    assert safetensors.__version__ == "0.8.0"
    checks = []
    for device in ["cpu", *( ["cuda"] if torch.cuda.is_available() else []),
                   *( ["mps"] if torch.backends.mps.is_available() else [])]:
        dtype = torch.bfloat16 if device == "cuda" and torch.cuda.is_bf16_supported() else torch.float32
        value = torch.arange(16, device=device, dtype=dtype).reshape(4, 4)
        assert torch.isfinite(value @ value).all().item()
        query = torch.ones((1, 2, 8, 4), device=device, dtype=dtype)
        assert torch.isfinite(torch.nn.functional.scaled_dot_product_attention(query, query, query)).all().item()
        if device == "cuda":
            torch.cuda.synchronize()
        elif device == "mps":
            torch.mps.synchronize()
        checks.append(dict(device=device, matmul=True, attention=True, dtype=str(dtype)))
    if args.require_gpu and len(checks) < 2:
        raise RuntimeError("A real GPU is required by this validation job")
    with tempfile.TemporaryDirectory(prefix="ai-runtime-check-") as temporary:
        root = Path(temporary)
        Image.new("RGB", (8, 8), (12, 24, 36)).save(root / "probe.png")
        assert Image.open(root / "probe.png").size == (8, 8)
        soundfile.write(root / "probe.wav", torch.zeros(480).numpy(), 48000)
        assert soundfile.info(root / "probe.wav").frames == 480
    print(json.dumps(dict(schema=1, imports=True, imagePipelines=4, musicHandler=True,
                          cpuCompute=True, gpuCompute=len(checks) > 1, devices=checks,
                          cudaVersion=torch.version.cuda, offline=True,
                          actualModelGeneration="not-run", modelWeightsIncluded=False)), flush=True)


if __name__ == "__main__":
    main()
