"""Device dispatch contracts; real synthesis is validated separately."""

import importlib.util
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch


SOURCE = Path(__file__).with_name("speech-device-runtime.py")
spec = importlib.util.spec_from_file_location("speech_device_runtime", SOURCE)
device_runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(device_runtime)


def torch_fixture(*, cuda=False, mps=False):
    return SimpleNamespace(
        cuda=SimpleNamespace(is_available=lambda: cuda, empty_cache=Mock()),
        backends=SimpleNamespace(mps=SimpleNamespace(is_built=lambda: mps, is_available=lambda: mps)),
        mps=SimpleNamespace(empty_cache=Mock()),
        set_num_threads=Mock(), set_num_interop_threads=Mock(),
    )


class DeviceSelectionTests(unittest.TestCase):
    def test_qwen_uses_explicit_grouped_attention_only_on_mps(self):
        self.assertEqual(device_runtime.qwen_attention_implementation("mps"), "eager")
        for device in ("cpu", "cuda"):
            self.assertEqual(device_runtime.qwen_attention_implementation(device), "sdpa")

    def test_qwen_loader_configures_main_model_and_independent_audio_decoder(self):
        for device in ("mps", "cuda"):
            with self.subTest(device=device):
                layers = [SimpleNamespace(num_key_value_groups=2, q_proj=object(),
                                          config=SimpleNamespace(_attn_implementation="sdpa")) for _ in range(2)]
                def component(layer):
                    def select(value):
                        layer.config._attn_implementation = value
                    return SimpleNamespace(set_attn_implementation=Mock(side_effect=select),
                                           modules=lambda: [layer])
                main, decoder = [component(layer) for layer in layers]
                main.speech_tokenizer = SimpleNamespace(model=SimpleNamespace(decoder=decoder))
                model = SimpleNamespace(model=main)
                loader = Mock(return_value=model)
                runtime = SimpleNamespace(local_path=lambda *args, **kwargs: Path("model"), stage=Mock())
                with patch.dict(sys.modules, {"qwen_tts": SimpleNamespace(Qwen3TTSModel=SimpleNamespace(from_pretrained=loader))}):
                    actual = device_runtime.load_qwen_model(runtime, {"model": "."}, Path("model"),
                                                           SimpleNamespace(bfloat16="bf16"), device)
                self.assertIs(actual, model)
                self.assertEqual(loader.call_args.kwargs["attn_implementation"], "eager" if device == "mps" else "sdpa")
                self.assertEqual(loader.call_args.kwargs["dtype"], "bf16")
                if device == "mps":
                    main.set_attn_implementation.assert_called_once_with("eager")
                    decoder.set_attn_implementation.assert_called_once_with("eager")
                    self.assertTrue(all(layer.config._attn_implementation == "eager" for layer in layers))
                else:
                    main.set_attn_implementation.assert_not_called()
                    decoder.set_attn_implementation.assert_not_called()

    def test_qwen_refuses_silently_ignored_attention_configuration(self):
        layer = SimpleNamespace(num_key_value_groups=2, q_proj=object(), config=SimpleNamespace(_attn_implementation="sdpa"))
        component = SimpleNamespace(set_attn_implementation=Mock(), modules=lambda: [layer])
        component.speech_tokenizer = SimpleNamespace(model=SimpleNamespace(decoder=component))
        model = SimpleNamespace(model=component)
        runtime = SimpleNamespace(local_path=lambda *args, **kwargs: Path("model"), stage=Mock())
        with patch.dict(sys.modules, {"qwen_tts": SimpleNamespace(Qwen3TTSModel=SimpleNamespace(from_pretrained=Mock(return_value=model)))}), \
                self.assertRaisesRegex(RuntimeError, "explicit grouped attention"):
            device_runtime.load_qwen_model(runtime, {"model": "."}, Path("model"), SimpleNamespace(bfloat16="bf16"), "mps")

    def test_auto_prefers_cuda_then_mps_then_cpu(self):
        self.assertEqual(device_runtime.gpu_candidates(torch_fixture(cuda=True, mps=True), "auto"), ["cuda"])
        self.assertEqual(device_runtime.gpu_candidates(torch_fixture(mps=True), "auto"), ["mps"])
        self.assertEqual(device_runtime.gpu_candidates(torch_fixture(), "auto"), [])

    def test_explicit_cpu_does_not_select_available_gpu(self):
        self.assertEqual(device_runtime.gpu_candidates(torch_fixture(cuda=True, mps=True), "cpu"), [])
        for gpu in ("cuda", "mps"):
            self.assertEqual(device_runtime.gpu_candidates(torch_fixture(), gpu), [gpu])
        with self.assertRaises(ValueError):
            device_runtime.gpu_candidates(torch_fixture(), "automatic")

    def test_probe_rejects_unavailable_gpu_before_allocating(self):
        for gpu in ("cuda", "mps"):
            with self.subTest(device=gpu), self.assertRaisesRegex(RuntimeError, "unavailable"):
                device_runtime.probe_device(torch_fixture(), gpu, "qwen3")

    def test_bfloat_gpu_requires_supported_hardware_and_os(self):
        cuda = torch_fixture(cuda=True)
        cuda.cuda.is_bf16_supported = lambda: False
        with self.assertRaisesRegex(RuntimeError, "bfloat16"):
            device_runtime.probe_device(cuda, "cuda", "qwen3")
        mps = torch_fixture(mps=True)
        mps.backends.mps.is_macos_or_newer = lambda major, minor: False
        with self.assertRaisesRegex(RuntimeError, "macOS 14"):
            device_runtime.probe_device(mps, "mps", "qwen3")

    def test_parameters_must_be_on_requested_device_and_precision(self):
        parameter = lambda device, dtype: SimpleNamespace(
            device=SimpleNamespace(type=device), dtype=dtype, is_floating_point=lambda: True)
        model = lambda *parameters: SimpleNamespace(parameters=lambda: iter(parameters))
        device_runtime.require_module_device(model(parameter("mps", "bf16")), "mps", dtype="bf16")
        for invalid in (model(), model(parameter("cpu", "bf16")), model(parameter("mps", "fp32"))):
            with self.subTest(model=invalid), self.assertRaises(RuntimeError):
                device_runtime.require_module_device(invalid, "mps", dtype="bf16")

    def test_decoder_cpu_transition_preserves_precision_and_updates_devices(self):
        parameter = SimpleNamespace(device=SimpleNamespace(type="mps"), dtype="bf16", is_floating_point=lambda: True)
        model = SimpleNamespace(device=parameter.device, hf_device_map={"": "mps"}, parameters=lambda: iter([parameter]))

        def move(*, device):
            parameter.device = SimpleNamespace(type=device)
            model.device = parameter.device
            return model

        model.to = move
        tokenizer = SimpleNamespace(model=model, device=SimpleNamespace(type="mps"))
        events = []
        runtime = SimpleNamespace(stage=lambda name, **fields: events.append((name, fields)))
        torch = SimpleNamespace(device=lambda name: SimpleNamespace(type=name))
        device_runtime.move_decoder_to_cpu(runtime, tokenizer, torch, "mps",
                                           {"engine": "qwen3", "dtype": "bfloat16"}, "Decoder operation unsupported")
        self.assertEqual(tokenizer.device.type, "cpu")
        self.assertEqual(model.device.type, "cpu")
        self.assertEqual(model.hf_device_map, {"": "cpu"})
        self.assertEqual(parameter.dtype, "bf16")
        self.assertEqual(events[0][1]["device"], "mps")
        self.assertEqual(events[0][1]["partial"], "audio-cpu")

    def test_audio_capability_probe_failure_does_not_claim_main_gpu_failure(self):
        events = []
        runtime = SimpleNamespace(stage=lambda name, **fields: events.append((name, fields)))
        device_runtime.report_audio_cpu(runtime, "mps", {"engine": "f5", "dtype": "float32"}, "FFT unavailable")
        self.assertEqual(events, [("device", {"device": "mps", "engine": "f5", "dtype": "float32",
                                              "partial": "audio-cpu", "reason": "FFT unavailable"})])


class DispatchTests(unittest.TestCase):
    def setUp(self):
        self.torch = torch_fixture(mps=True)
        self.events = []
        self.config = {"engine": "qwen3", "dtype": "bfloat16", "speaker": "Uncle_Fu"}
        self.runtime = SimpleNamespace(
            load_config=Mock(return_value=(self.config, Path("model"))),
            read_text=Mock(return_value="这是一款全程由AI接管并生成的软件"),
            stage=lambda name, **fields: self.events.append((name, fields)),
            generate_qwen=Mock(return_value="cpu-wave"),
            generate_f5=Mock(return_value="cpu-wave"),
            write_audio=Mock(return_value={"sampleRate": 24000}),
        )
        self.args = SimpleNamespace(config=Path("config.json"), text_file=Path("text.txt"),
                                    output_filename=Path("speech.wav"), speed=1, threads=4,
                                    self_test=False, device="auto")
        self.imports = patch.dict(sys.modules, {
            "torch": self.torch, "numpy": SimpleNamespace(), "soundfile": SimpleNamespace()})
        self.imports.start()
        self.addCleanup(self.imports.stop)
        self.prints = patch("builtins.print")
        self.prints.start()
        self.addCleanup(self.prints.stop)

    def test_successful_gpu_does_not_call_cpu_and_keeps_voice(self):
        with patch.object(device_runtime, "generate_gpu", return_value="gpu-wave") as generate:
            device_runtime.run(self.runtime, self.args)
        self.assertIs(generate.call_args.args[1], self.config)
        self.assertEqual(generate.call_args.args[-1], "mps")
        self.runtime.generate_qwen.assert_not_called()
        self.assertEqual(self.runtime.write_audio.call_args.args[1], "gpu-wave")
        self.torch.mps.empty_cache.assert_called_once()
        self.assertEqual([entry[1]["device"] for entry in self.events if entry[0] == "device"], ["mps"])

    def test_gpu_failure_releases_memory_then_retries_cpu_once(self):
        order = []
        self.runtime.generate_qwen.side_effect = lambda *args: order.append("cpu") or "cpu-wave"
        with patch.object(device_runtime, "generate_gpu", side_effect=RuntimeError("unsupported, operation\nfailed")), \
                patch.object(device_runtime, "release_device", side_effect=lambda *args: order.append("release")):
            device_runtime.run(self.runtime, self.args)
        self.assertEqual(order, ["release", "cpu"])
        self.runtime.generate_qwen.assert_called_once()
        fallback = [fields for name, fields in self.events if name == "fallback"]
        self.assertEqual(len(fallback), 1)
        self.assertEqual(fallback[0]["from"], "mps")
        self.assertEqual(fallback[0]["device"], "cpu")
        self.assertNotIn(",", fallback[0]["reason"])
        self.assertNotIn("\n", fallback[0]["reason"])
        self.assertEqual([entry[1]["device"] for entry in self.events if entry[0] == "device"], ["mps", "cpu"])
        self.assertEqual(self.runtime.write_audio.call_args.args[1], "cpu-wave")

    def test_failed_cpu_attempt_is_not_retried(self):
        self.runtime.generate_qwen.side_effect = RuntimeError("CPU failed")
        with patch.object(device_runtime, "generate_gpu", side_effect=RuntimeError("GPU failed")) as generate, \
                self.assertRaisesRegex(RuntimeError, "CPU failed"):
            device_runtime.run(self.runtime, self.args)
        generate.assert_called_once()
        self.runtime.generate_qwen.assert_called_once()
        self.runtime.write_audio.assert_not_called()

    def test_driver_discovery_failure_is_an_explicit_cpu_fallback(self):
        with patch.object(device_runtime, "gpu_candidates", side_effect=RuntimeError("Driver initialization failed")), \
                patch.object(device_runtime, "generate_gpu") as generate:
            device_runtime.run(self.runtime, self.args)
        generate.assert_not_called()
        self.runtime.generate_qwen.assert_called_once()
        fallback = [fields for name, fields in self.events if name == "fallback"]
        self.assertEqual(len(fallback), 1)
        self.assertEqual(fallback[0]["device"], "cpu")

    def test_no_gpu_auto_uses_cpu_without_claiming_gpu_execution(self):
        self.torch.cuda.is_available = lambda: False
        self.torch.backends.mps.is_available = lambda: False
        with patch.object(device_runtime, "generate_gpu") as generate:
            device_runtime.run(self.runtime, self.args)
        generate.assert_not_called()
        self.runtime.generate_qwen.assert_called_once()
        self.assertEqual([entry[1]["device"] for entry in self.events if entry[0] == "device"], ["cpu"])

    def test_interrupt_or_exit_never_restarts_inference(self):
        for cause in (KeyboardInterrupt(), SystemExit(2)):
            with self.subTest(cause=type(cause).__name__), \
                    patch.object(device_runtime, "generate_gpu", side_effect=cause), \
                    self.assertRaises(type(cause)):
                device_runtime.run(self.runtime, self.args)
        self.runtime.generate_qwen.assert_not_called()
        self.runtime.write_audio.assert_not_called()
        self.assertFalse(any(name == "fallback" for name, _ in self.events))
        self.assertEqual(self.torch.mps.empty_cache.call_count, 2)

    def test_write_error_does_not_repeat_gpu_or_start_cpu(self):
        self.runtime.write_audio.side_effect = OSError("Disk full")
        with patch.object(device_runtime, "generate_gpu", return_value="gpu-wave") as generate, \
                self.assertRaisesRegex(OSError, "Disk full"):
            device_runtime.run(self.runtime, self.args)
        generate.assert_called_once()
        self.runtime.generate_qwen.assert_not_called()
        self.assertFalse(any(name == "fallback" for name, _ in self.events))

    def test_cpu_dispatch_preserves_original_engine_implementation(self):
        self.args.device = "cpu"
        for engine, dtype in (("f5", "float32"), ("qwen3", "bfloat16")):
            self.config.update(engine=engine, dtype=dtype)
            with self.subTest(engine=engine), patch.object(device_runtime, "generate_gpu") as generate:
                device_runtime.run(self.runtime, self.args)
                generate.assert_not_called()
        self.runtime.generate_f5.assert_called_once()
        self.runtime.generate_qwen.assert_called_once()

    def test_invalid_configuration_never_probes_or_allocates(self):
        self.runtime.load_config.side_effect = ValueError("Unsupported precision")
        with patch.object(device_runtime, "gpu_candidates") as select, self.assertRaises(ValueError):
            device_runtime.run(self.runtime, self.args)
        select.assert_not_called()
        self.torch.set_num_threads.assert_not_called()
        self.runtime.write_audio.assert_not_called()

    def test_disabled_implicit_cpu_fallback(self):
        self.args.device = "cpu"
        with patch.dict(os.environ, {"PYTORCH_ENABLE_MPS_FALLBACK": "1"}):
            device_runtime.run(self.runtime, self.args)
            self.assertNotIn("PYTORCH_ENABLE_MPS_FALLBACK", os.environ)


class DecoderGuardTests(unittest.TestCase):
    def setUp(self):
        class Codes:
            ndim = 2

            def __init__(self, frames=80):
                self.shape = (frames, 16)

            def __getitem__(self, item):
                return Codes(min(self.shape[0], item.stop))

        self.codes = Codes()
        self.parameter = SimpleNamespace(device=SimpleNamespace(type="mps"), dtype="bf16", is_floating_point=lambda: True)
        self.model = SimpleNamespace(device=self.parameter.device, hf_device_map={"": "mps"},
                                     parameters=lambda: iter([self.parameter]))

        def move(*, device):
            self.parameter.device = SimpleNamespace(type=device)
            self.model.device = self.parameter.device
            return self.model

        self.model.to = Mock(side_effect=move)
        self.tokenizer = SimpleNamespace(model=self.model, device=SimpleNamespace(type="mps"))
        self.calls = []

        def decode(encoded):
            frames = encoded[0]["audio_codes"].shape[0]
            self.calls.append((self.tokenizer.device.type, frames))
            return ([[0.1] * frames], 24000)

        self.decode = Mock(side_effect=decode)
        self.tokenizer.decode = self.decode
        self.events = []
        self.runtime = SimpleNamespace(SAMPLE_RATE=24000, stage=lambda name, **fields: self.events.append((name, fields)))
        self.config = {"engine": "qwen3", "dtype": "bfloat16"}
        self.torch = SimpleNamespace(device=lambda name: SimpleNamespace(type=name), mps=SimpleNamespace(synchronize=Mock()))
        self.compare = patch.object(device_runtime, "decoder_relative_error", return_value=0.01)
        self.compare_mock = self.compare.start()
        self.addCleanup(self.compare.stop)
        device_runtime.guard_qwen_decoder(self.runtime, self.config, self.tokenizer, self.torch, object(), "mps")

    def test_correct_decoder_returns_full_gpu_audio_and_bounds_cpu_check(self):
        result = self.tokenizer.decode([{"audio_codes": self.codes}])
        self.assertEqual(self.calls, [("mps", 80), ("cpu", 24)])
        self.assertEqual(len(result[0][0]), 80)
        self.assertEqual(len(self.compare_mock.call_args.args[0][0][0]), 24)
        self.assertEqual(self.tokenizer.device.type, "mps")
        self.assertEqual(self.model.hf_device_map, {"": "mps"})
        self.assertFalse(any(fields.get("partial") == "audio-cpu" for _, fields in self.events))
        self.assertTrue(any(fields.get("status") == "passed" for _, fields in self.events))

    def test_finite_but_corrupt_decode_retries_same_codes_only_on_cpu(self):
        self.compare_mock.return_value = 0.8
        result = self.tokenizer.decode([{"audio_codes": self.codes}])
        self.assertEqual(self.calls, [("mps", 80), ("cpu", 24), ("cpu", 80)])
        self.assertEqual(len(result[0][0]), 80)
        self.assertEqual(self.tokenizer.device.type, "cpu")
        self.assertEqual(self.parameter.dtype, "bf16")
        self.assertTrue(any(fields.get("partial") == "audio-cpu" for _, fields in self.events))
        self.tokenizer.decode([{"audio_codes": self.codes}])
        self.assertEqual(self.calls[-1], ("cpu", 80))
        self.compare_mock.assert_called_once()

    def test_gpu_decode_exception_keeps_generated_codes_for_cpu_recovery(self):
        original = self.decode.side_effect
        self.decode.side_effect = lambda codes: (_ for _ in ()).throw(RuntimeError("Decoder allocation failed")) \
            if self.tokenizer.device.type == "mps" else original(codes)
        result = self.tokenizer.decode([{"audio_codes": self.codes}])
        self.assertEqual(self.calls, [("cpu", 24), ("cpu", 80)])
        self.assertEqual(len(result[0][0]), 80)
        self.assertTrue(any(fields.get("status") == "recovered" for _, fields in self.events))

    def test_invalid_reference_does_not_publish_gpu_noise(self):
        self.compare_mock.side_effect = RuntimeError("Reference returned invalid samples")
        with self.assertRaisesRegex(RuntimeError, "invalid samples"):
            self.tokenizer.decode([{"audio_codes": self.codes}])
        self.assertFalse(any(fields.get("status") == "passed" for _, fields in self.events))

    def test_cancelled_decode_never_retries_or_moves_model(self):
        self.decode.side_effect = KeyboardInterrupt()
        with self.assertRaises(KeyboardInterrupt):
            self.tokenizer.decode([{"audio_codes": self.codes}])
        self.model.to.assert_not_called()

    def test_invalid_code_shape_is_rejected_before_decoding(self):
        self.codes.shape = (1, 24, 16)
        self.codes.ndim = 3
        with self.assertRaisesRegex(RuntimeError, "code dimensions"):
            self.tokenizer.decode([{"audio_codes": self.codes}])
        self.decode.assert_not_called()


if __name__ == "__main__":
    unittest.main()
