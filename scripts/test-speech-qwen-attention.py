#!/usr/bin/env python3
"""Real tensor regression for the shipped grouped-attention implementation.

Requires the verified speech runtime dependencies, but no model downloads.
CPU execution validates the math; only --device mps validates MPS operators.
"""
import argparse
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--device', choices=('cpu', 'mps', 'cuda'), default='cpu')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    import torch
    from qwen_tts.core.models.modeling_qwen3_tts import eager_attention_forward
    source = Path(__file__).with_name('speech-device-runtime.py')
    spec = importlib.util.spec_from_file_location('speech_device', source)
    device_runtime = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(device_runtime)
    torch.set_num_threads(4)
    torch.manual_seed(20261018)
    cases = []
    module = SimpleNamespace(num_key_value_groups=2, training=False)
    # The two 49-token cases match the reported failure dimensions. The final
    # cases exercise cached decoding and an attention mask with a cache offset.
    with torch.inference_mode():
        for query_length, key_length, causal in ((49, 49, False), (49, 49, True), (1, 50, False), (7, 13, True)):
            query = torch.randn(1, 16, query_length, 128, dtype=torch.bfloat16)
            key = torch.randn(1, 8, key_length, 128, dtype=torch.bfloat16)
            value = torch.randn_like(key)
            mask = None
            if causal:
                allowed = torch.arange(key_length)[None, :] <= torch.arange(query_length)[:, None] + key_length - query_length
                mask = torch.zeros(query_length, key_length, dtype=torch.bfloat16).masked_fill(~allowed, float('-inf'))[None, None]
            with patch('torch.nn.functional.scaled_dot_product_attention', side_effect=AssertionError('Eager attention must not dispatch to SDPA')):
                actual, weights = eager_attention_forward(
                    module, query.to(args.device), key.to(args.device), value.to(args.device),
                    mask.to(args.device) if mask is not None else None, scaling=128 ** -.5)
            # Independent per-head FP32 reference. Head 2n and 2n+1 both use
            # KV head n, matching the checkpoint's grouped-attention contract.
            heads = []
            for head in range(16):
                scores = query[:, head].float() @ key[:, head // 2].float().transpose(-1, -2) * (128 ** -.5)
                if mask is not None:
                    scores = scores + mask[:, 0].float()
                heads.append(torch.softmax(scores, -1) @ value[:, head // 2].float())
            expected = torch.stack(heads, dim=2)
            observed = actual.float().cpu()
            assert actual.shape == (1, query_length, 16, 128)
            assert actual.device.type == args.device and actual.dtype == torch.bfloat16
            assert torch.isfinite(actual).all() and torch.isfinite(weights).all()
            torch.testing.assert_close(observed, expected, rtol=.03, atol=.02)
            difference = observed - expected
            cases.append(dict(queryShape=list(query.shape), keyShape=list(key.shape), causal=causal,
                              outputShape=list(actual.shape), dtype=str(actual.dtype), finite=True,
                              maxAbsoluteDifference=float(difference.abs().max()),
                              rmsDifference=float(difference.square().mean().sqrt()),
                              relativeTolerance=.03, absoluteTolerance=.02))
        # Exercise the application's actual preflight helper on the same real
        # tensors; CPU is used only as a math test of the MPS eager branch.
        with patch.object(device_runtime, 'qwen_attention_implementation', return_value='eager'), \
                patch('torch.nn.functional.scaled_dot_product_attention', side_effect=AssertionError('MPS probe must use explicit KV repetition')):
            outputs = device_runtime.probe_qwen_grouped_attention(torch, args.device)
        assert all(value.dtype == torch.bfloat16 and torch.isfinite(value).all() for value in outputs)
    result = dict(schema=1, status='passed', device=args.device, hardwareMpsVerified=args.device == 'mps',
                  torchVersion=torch.__version__, implementation='eager', sdpaInvoked=False,
                  applicationProbePassed=True, cases=cases)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(result), flush=True)


if __name__ == '__main__':
    main()
