"""Adapter contract tests. These do not download models or assert generated-image quality."""

import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import struct
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock


SCRIPT = Path(__file__).with_name("ai-image-runner.py")
SPEC = importlib.util.spec_from_file_location("ai_image_runner", SCRIPT)
RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER)


def torch_contract(cuda=False, mps=False, bf16=True, macos14=True):
    return SimpleNamespace(
        cuda=SimpleNamespace(is_available=lambda: cuda, is_bf16_supported=lambda: bf16),
        backends=SimpleNamespace(mps=SimpleNamespace(is_available=lambda: mps,
                                                   is_macos_or_newer=lambda *_: macos14)),
        bfloat16="bfloat16", float16="float16", float32="float32",
        Generator=lambda **_: SimpleNamespace(manual_seed=lambda seed: seed),
        inference_mode=contextlib.nullcontext,
    )


def write_weight_fixture(path, tensors):
    sizes = {"F16": 2, "BF16": 2, "F32": 4, "I64": 8}
    header, offset = {}, 0
    for name, dtype, shape in tensors:
        count = 1
        for size in shape:
            count *= size
        size = count * sizes[dtype]
        header[name] = {"dtype": dtype, "shape": shape, "data_offsets": [offset, offset + size]}
        offset += size
    encoded = json.dumps(header).encode("utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(struct.pack("<Q", len(encoded)) + encoded + bytes(offset))


class ImageAdapterContract(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.model = self.root / "model"
        self.model.mkdir()
        (self.model / "model_index.json").write_text("{}")
        self.weight_file = self.model / "transformer/model.safetensors"
        write_weight_fixture(self.weight_file, [("weight", "F32", [1])])
        self.request = {
            "modelId": "qwen-image", "modelRoot": str(self.model), "prompt": "一座雪山",
            "outputPath": str(self.root / "output.png"), "width": 512, "height": 512, "seed": 4,
        }

    def test_guidance_mapping_does_not_silently_ignore_the_requested_value(self):
        qwen = RUNNER.validate_request({**self.request, "guidance": 5})
        args = RUNNER.pipeline_arguments(qwen)
        self.assertEqual(args["true_cfg_scale"], 5)
        self.assertEqual(args["negative_prompt"], " ")
        self.assertNotIn("guidance_scale", args)
        turbo = RUNNER.validate_request({**self.request, "modelId": "z-image-turbo"})
        args = RUNNER.pipeline_arguments(turbo)
        self.assertEqual(args["guidance_scale"], 0)
        self.assertEqual(args["num_inference_steps"], 9)
        self.assertNotIn("negative_prompt", args)
        with self.assertRaisesRegex(ValueError, "negative prompts"):
            RUNNER.validate_request({**self.request, "modelId": "z-image-turbo", "negativePrompt": "blur"})
        with self.assertRaisesRegex(ValueError, "guidance=0"):
            RUNNER.validate_request({**self.request, "modelId": "z-image-turbo", "guidance": 3})

    def test_image_to_image_requires_an_image_and_effective_steps(self):
        image = self.root / "reference.png"
        image.write_bytes(b"reference contract fixture")
        request = {**self.request, "mode": "image-to-image", "inputImagePath": str(image), "steps": 4}
        with self.assertRaisesRegex(ValueError, "at least one"):
            RUNNER.validate_request({**request, "strength": 0.2})
        parsed = RUNNER.validate_request({**request, "strength": 0.5})
        self.assertEqual(RUNNER.pipeline_arguments(parsed)["strength"], 0.5)
        with self.assertRaisesRegex(ValueError, "absolute local"):
            RUNNER.validate_request({**request, "inputImagePath": "https://example.org/image.png"})
        with self.assertRaisesRegex(ValueError, "requires image-to-image"):
            RUNNER.validate_request({**self.request, "inputImagePath": str(image)})

    def test_null_optional_native_fields_use_model_defaults(self):
        result = RUNNER.validate_request({**self.request, "modelId": "z-image-turbo", "steps": None,
                                          "guidance": None, "negativePrompt": None, "device": None})
        self.assertEqual(result["steps"], 9)
        self.assertEqual(result["guidance"], 0)
        self.assertEqual(result["device"], "auto")

    def test_invalid_numeric_values_and_output_collisions_are_rejected(self):
        for update in ({"width": 513}, {"height": True}, {"steps": 0}, {"seed": -1},
                       {"strength": float("nan")}, {"guidance": float("inf")}, {"width": 4096}):
            with self.subTest(update=update), self.assertRaises(ValueError):
                RUNNER.validate_request({**self.request, **update})
        with self.assertRaisesRegex(ValueError, "overwrite model"):
            RUNNER.validate_request({**self.request, "outputPath": str(self.model / "image.png")})
        output = self.root / "output.png"
        output.write_bytes(b"existing asset")
        with self.assertRaisesRegex(ValueError, "already exists"):
            RUNNER.validate_request(self.request)
        self.assertEqual(output.read_bytes(), b"existing asset")

    def test_gpu_priority_and_precision_are_explicit(self):
        self.assertEqual(RUNNER.select_device(torch_contract(cuda=True, mps=True), "auto"), "cuda")
        self.assertEqual(RUNNER.select_device(torch_contract(mps=True), "auto"), "mps")
        self.assertEqual(RUNNER.select_device(torch_contract(), "auto"), "cpu")
        with self.assertRaisesRegex(RuntimeError, "unavailable"):
            RUNNER.select_device(torch_contract(), "cuda")
        self.assertEqual(RUNNER.select_dtype(torch_contract(), "cpu"), "float32")
        self.assertEqual(RUNNER.select_dtype(torch_contract(cuda=True, bf16=False), "cuda"), "float16")
        self.assertEqual(RUNNER.select_dtype(torch_contract(mps=True), "mps"), "bfloat16")
        self.assertEqual(RUNNER.select_dtype(torch_contract(mps=True, macos14=False), "mps"), "float32")

    def test_low_memory_uses_the_selected_accelerator(self):
        pipe = mock.Mock()
        RUNNER.configure_memory(pipe, "mps", "low")
        pipe.enable_sequential_cpu_offload.assert_called_once_with(device="mps")
        pipe.to.assert_not_called()
        pipe.vae.enable_tiling.assert_called_once_with()
        pipe.reset_mock()
        RUNNER.configure_memory(pipe, "cpu", "low")
        pipe.enable_sequential_cpu_offload.assert_not_called()
        pipe.to.assert_called_once_with("cpu")

    def test_weight_estimate_uses_tensor_shapes_and_target_precision_not_file_size(self):
        write_weight_fixture(self.weight_file, [("half", "F16", [2, 2]), ("brain", "BF16", [2, 3]),
                                               ("index", "I64", [1]), ("empty", "F32", [0])])
        self.assertEqual(RUNNER.weight_memory_bytes(self.model, 4), 48)
        self.assertEqual(RUNNER.weight_memory_bytes(self.model, 2), 28)
        self.assertGreater(self.weight_file.stat().st_size, 48)

    def test_corrupt_or_truncated_weight_headers_fail_without_reading_tensor_payloads(self):
        for content in (b"", struct.pack("<Q", 2**40), struct.pack("<Q", 100) + b"{}"):
            self.weight_file.write_bytes(content)
            with self.assertRaises(RUNNER.WeightInspectionError):
                RUNNER.weight_memory_bytes(self.model, 4)
        malformed = json.dumps({"weight": {"dtype": "F16", "shape": [16], "data_offsets": [0, 32]}}).encode()
        self.weight_file.write_bytes(struct.pack("<Q", len(malformed)) + malformed)
        with self.assertRaises(RUNNER.WeightInspectionError):
            RUNNER.weight_memory_bytes(self.model, 4)

    def test_cpu_guard_stops_before_loading_and_mps_only_warns(self):
        write_weight_fixture(self.weight_file, [("weight", "F16", [16])])
        events = []
        loader = mock.Mock()
        with mock.patch.object(RUNNER, "physical_memory_bytes", return_value=32), \
                mock.patch.object(RUNNER, "emit", lambda stage, **kw: events.append({"stage": stage, **kw})), \
                mock.patch.dict(sys.modules, {"torch": torch_contract(), "PIL": SimpleNamespace(Image=None, ImageOps=None),
                                              "diffusers": SimpleNamespace(QwenImagePipeline=SimpleNamespace(from_pretrained=loader))}):
            with self.assertRaises(RUNNER.MemoryPreflightError) as error:
                RUNNER.run(RUNNER.validate_request({**self.request, "device": "cpu"}))
            self.assertEqual(error.exception.code, "INSUFFICIENT_PHYSICAL_MEMORY")
            loader.assert_not_called()
            self.assertTrue(any(item.get("weightBytes") == 64 and item.get("physicalMemoryBytes") == 32 for item in events))
            RUNNER.memory_preflight(self.model, "mps", 4)
            self.assertTrue(any(item.get("device") == "mps" and "warning" in item for item in events))
        with mock.patch.object(RUNNER, "physical_memory_bytes", return_value=64), mock.patch.object(RUNNER, "emit"):
            # Equal lower-bound memory is not rejected using an invented activation allowance.
            RUNNER.memory_preflight(self.model, "cpu", 4)

    def test_validate_cli_does_not_import_or_require_inference_dependencies(self):
        request_file = self.root / "request.json"
        request_file.write_text(json.dumps(self.request), encoding="utf-8")
        result = subprocess.run([sys.executable, "-S", str(SCRIPT), "--request", str(request_file),
                                 "--validate-only"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["stage"], "validated")
        self.assertFalse((self.root / "output.png").exists())

    def test_real_callback_counts_and_local_only_loading_contract(self):
        try:
            from PIL import Image
        except ImportError:
            self.skipTest("Pillow is required for the PNG adapter contract")
        events = []
        load = mock.Mock()

        class Pipeline:
            num_timesteps = 2
            vae = mock.Mock()

            @classmethod
            def from_pretrained(cls, *args, **kwargs):
                load(*args, **kwargs)
                return cls()

            def set_progress_bar_config(self, **kwargs):
                pass

            def to(self, _device):
                return self

            def __call__(self, **args):
                for step in range(self.num_timesteps):
                    original = {"latents": object()}
                    self_test.assertIs(args["callback_on_step_end"](self, step, None, original), original)
                return SimpleNamespace(images=[Image.new("RGB", (512, 512), "navy")])

        self_test = self
        request = RUNNER.validate_request({**self.request, "device": "cpu"})
        with mock.patch.dict(sys.modules, {"torch": torch_contract(),
                                          "diffusers": SimpleNamespace(QwenImagePipeline=Pipeline)}), \
                mock.patch.object(RUNNER, "emit", lambda stage, **kw: events.append({"stage": stage, **kw})):
            RUNNER.run(request)
        self.assertTrue(load.call_args.kwargs["local_files_only"])
        self.assertTrue(load.call_args.kwargs["use_safetensors"])
        self.assertEqual(load.call_args.args[0], str(self.model))
        steps = [event for event in events if event["stage"] == "denoising"]
        self.assertEqual([event["progress"] for event in steps], [0.5, 1])
        self.assertEqual([event["totalSteps"] for event in steps], [2, 2])
        self.assertTrue(all("progress" not in event for event in events if event["stage"] in ("loading", "encoding")))
        self.assertEqual(events[-1]["stage"], "complete")
        with Image.open(self.root / "output.png") as result:
            result.verify()
        self.assertFalse(list(self.root.glob("*.partial")))

    def test_catalog_files_are_pinned_and_total_matches_the_payload(self):
        catalog = json.loads((SCRIPT.parent.parent / "src-tauri/resources/ai-image-models.json").read_text())
        self.assertEqual({item["id"] for item in catalog["models"]}, set(RUNNER.MODELS))
        for model in catalog["models"]:
            self.assertEqual(model["downloadBytes"], sum(item["size"] for item in model["files"]))
            self.assertEqual(set(model["modes"]), set(RUNNER.MODELS[model["id"]]))
            self.assertEqual(len({item["path"] for item in model["files"]}), len(model["files"]))
            for item in model["files"]:
                self.assertRegex(item["sha256"], r"^[a-f0-9]{64}$")
                self.assertFalse(Path(item["path"]).is_absolute())
                self.assertNotIn("..", Path(item["path"]).parts)
                for url in item["urls"]:
                    self.assertIn("/resolve/" + model["version"] + "/", url)


if __name__ == "__main__":
    unittest.main()
