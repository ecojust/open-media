"""Native component verification must distinguish CPU recovery from GPU proof."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import wave

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('native_gpu_builder', ROOT / 'scripts/native-speech-gpu-runtime.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class NativeComponentValidationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='native-gpu-validation-')
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.output = self.root / 'voice'
        self.calls = []

    def process(self, command, **kwargs):
        self.calls.append(command)
        if command[0] == 'gpu-helper':
            return SimpleNamespace(returncode=-6, stdout='stage=device,device=cuda\nstage=generating\n', stderr='native abort')
        path = Path(next(item.split('=', 1)[1] for item in command if item.startswith('--output-filename=')))
        with wave.open(str(path), 'wb') as output:
            output.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
            output.writeframes(b'\x00\x10\x00\xf0' * 2000)
        return SimpleNamespace(returncode=0, stdout='stage=device,device=cpu\nstage=writing\nstage=complete\n', stderr='')

    def test_crashed_gpu_uses_original_cpu_executable_and_records_actual_backend(self):
        with patch.object(builder.subprocess, 'run', side_effect=self.process):
            result = builder.attempt_voice('gpu-helper', 'cpu-helper', ['--sid=0'], self.output, self.root, 16000)
        self.assertEqual([item[0] for item in self.calls], ['gpu-helper', 'cpu-helper'])
        self.assertIn('--provider=cpu', self.calls[1])
        self.assertEqual(result['actualDevice'], 'cpu')
        self.assertTrue(result['fallback'])
        self.assertFalse(result['gpuInferenceVerified'])
        self.assertEqual(result['attempts'][0]['exitCode'], -6)

    def test_missing_device_or_disk_error_never_recomputes(self):
        for text in ['stage=loading\n', 'stage=device,device=cuda\nstage=writing\n']:
            with self.subTest(text=text), patch.object(builder.subprocess, 'run', return_value=
                    SimpleNamespace(returncode=3, stdout=text, stderr='failed')) as process:
                with self.assertRaises(ValueError):
                    builder.attempt_voice('gpu-helper', 'cpu-helper', [], self.output, self.root, 16000)
                process.assert_called_once()

    def test_timeout_never_starts_cpu_retry(self):
        with patch.object(builder.subprocess, 'run', side_effect=subprocess.TimeoutExpired('gpu-helper', 1800)) as process:
            with self.assertRaises(subprocess.TimeoutExpired):
                builder.attempt_voice('gpu-helper', 'cpu-helper', [], self.output, self.root, 16000)
            process.assert_called_once()

    def test_official_provider_registration_requires_complete_non_inference_proof(self):
        log = self.root / 'provider-load.log'
        expected = dict(provider='cuda', providerLoadVerified=True, gpuInferenceVerified=False,
                        selfTest='official-provider-registration')
        with patch.object(builder, 'run') as run:
            log.write_text(json.dumps(expected), encoding='utf-8')
            self.assertEqual(builder.verify_provider_load('gpu-helper', log), expected)
            run.assert_called_once_with(['gpu-helper', '--self-test-provider-load'], log)
        for record in [{}, {**expected, 'gpuInferenceVerified': True},
                       {**expected, 'providerLoadVerified': False}, {**expected, 'provider': 'cpu'}]:
            with self.subTest(record=record), patch.object(builder, 'run'):
                log.write_text(json.dumps(record), encoding='utf-8')
                with self.assertRaisesRegex(ValueError, 'official registration'):
                    builder.verify_provider_load('gpu-helper', log)

    def test_provider_initialization_failure_is_not_ignored(self):
        with patch.object(builder, 'run', side_effect=RuntimeError('CUDA DLL initialization failed')):
            with self.assertRaisesRegex(RuntimeError, 'CUDA DLL initialization failed'):
                builder.verify_provider_load('gpu-helper', self.root / 'provider-load.log')


if __name__ == '__main__':
    unittest.main()
