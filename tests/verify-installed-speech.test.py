"""Small fixtures for release verification; no downloads or model synthesis."""
import importlib.util
import json
import math
import os
from pathlib import Path
import shutil
import struct
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('verify_installed_speech', ROOT / 'scripts/verify-installed-speech.py')
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)


def wav(path, *, floating=False, silent=False, invalid=False, rate=16000, amplitude=.2):
    samples = [0 if silent else amplitude * math.sin(index * .2) for index in range(8000)]
    if invalid:
        samples[100] = float('nan')
    body = struct.pack('<' + ('f' if floating else 'h') * len(samples),
                       *(samples if floating else [int(value * 32767) for value in samples]))
    width = 4 if floating else 2
    fmt = struct.pack('<HHIIHH', 3 if floating else 1, 1, rate, rate * width, width, width * 8)
    data = b'WAVEfmt ' + struct.pack('<I', len(fmt)) + fmt + b'data' + struct.pack('<I', len(body)) + body
    path.write_bytes(b'RIFF' + struct.pack('<I', len(data)) + data)


class InstalledSpeechVerification(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='中文 验证-')
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_decodes_entire_pcm_and_float_audio(self):
        for floating in (False, True):
            path = self.root / f'{floating}.wav'
            wav(path, floating=floating)
            result = verify.inspect_audio(path)
            self.assertEqual(result['durationSeconds'], .5)
            self.assertTrue(result['finite'])
            self.assertGreater(result['rms'], .1)

    def test_rejects_silence_nonfinite_and_truncation(self):
        path = self.root / 'bad.wav'
        for args in ({'silent': True}, {'floating': True, 'invalid': True}):
            wav(path, **args)
            with self.assertRaises(ValueError):
                verify.inspect_audio(path)
        wav(path)
        path.write_bytes(path.read_bytes()[:-1])
        with self.assertRaises(ValueError):
            verify.inspect_audio(path)

    def test_preserves_finite_float_audio_above_unity(self):
        path = self.root / 'float.wav'
        wav(path, floating=True, amplitude=1.2)
        self.assertGreater(verify.inspect_audio(path)['peak'], 1)

    def package(self):
        source = self.root / 'source'
        (source / 'python/bin').mkdir(parents=True)
        (source / 'runner').mkdir()
        (source / 'python/bin/python3').write_bytes(b'fixture executable')
        (source / 'runner/tts.py').write_bytes(b'fixture runner')
        archive = self.root / 'release.zip'
        metadata = verify.integrity.package(source, archive, {'executable': 'python/bin/python3'}, 'test')
        return archive, metadata

    def test_fixed_archive_internal_manifest_files_and_modes(self):
        archive, metadata = self.package()
        installed = self.root / '安装 目录'
        verify.integrity.verify_archive(archive, installed, metadata)
        self.assertTrue(verify.integrity.verify_tree(installed, metadata)['unchanged'])
        runner = installed / 'runner/tts.py'
        runner.write_bytes(b'changed')
        with self.assertRaises(ValueError):
            verify.integrity.verify_tree(installed, metadata)

    @unittest.skipIf(os.name == 'nt', 'Windows has no POSIX executable mode')
    def test_changed_executable_permissions_fail(self):
        archive, metadata = self.package()
        installed = self.root / 'installed'
        verify.integrity.verify_archive(archive, installed, metadata)
        (installed / 'python/bin/python3').chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'permission'):
            verify.integrity.verify_tree(installed, metadata)

    def test_rejects_archive_and_manifest_tampering_or_extra_cache(self):
        archive, metadata = self.package()
        bad = self.root / 'tampered.zip'
        shutil.copyfile(archive, bad)
        with bad.open('ab') as stream:
            stream.write(b'extra')
        with self.assertRaises(ValueError):
            verify.integrity.verify_archive(bad, self.root / 'bad', metadata)
        installed = self.root / 'installed'
        verify.integrity.verify_archive(archive, installed, metadata)
        (installed / '__pycache__').mkdir()
        (installed / '__pycache__/cache.pyc').write_bytes(b'cache')
        with self.assertRaisesRegex(ValueError, 'file list'):
            verify.integrity.verify_tree(installed, metadata)

    def test_rejects_unsafe_zip_members_before_extraction(self):
        archive = self.root / 'unsafe.zip'
        with zipfile.ZipFile(archive, 'w') as target:
            target.writestr('../escaped', b'no')
        metadata = {'size': archive.stat().st_size, 'sha256': verify.integrity.sha256(archive)}
        with self.assertRaisesRegex(ValueError, 'Unsafe'):
            verify.integrity.verify_archive(archive, self.root / 'installed', metadata)
        self.assertFalse((self.root / 'escaped').exists())

    def proof(self, device='cpu', complete=True):
        voice = 'qwen3_serena'
        job = self.root / voice
        job.mkdir(exist_ok=True)
        wav(job / 'speech.wav', rate=24000)
        audio = verify.inspect_audio(job / 'speech.wav')
        proof = dict(voiceId=voice, success=True, audioValidated=True,
                     productionPath='SpeechRuntime::command + generate_wave', text=verify.TEXT,
                     audioSha256=audio['sha256'], audioBytes=audio['bytes'], sampleRate=audio['sampleRate'],
                     backend=device, elapsedSeconds=1.5)
        (job / 'result.json').write_text(json.dumps(proof), encoding='utf-8')
        (job / 'generation.log').write_text(
            f'stage=device,device={device},engine=qwen3,dtype=bfloat16\n'
            + ('stage=complete,engine=qwen3\n' if complete else ''), encoding='utf-8')
        return voice

    def test_accepts_cpu_only_as_cpu(self):
        voice = self.proof()
        proof = verify.collect_voice(self.root, voice, {'python': {'mpsAvailable': False, 'cudaAvailable': False}})
        self.assertEqual(proof['backend'], 'cpu')
        self.assertEqual(proof['requestedDevice'], 'auto')
        self.assertFalse(proof['gpuInferenceVerified'])
        self.assertEqual(proof['fallback'], [])
        self.assertTrue(proof['completionVerified'])

    def test_rejects_unavailable_gpu_and_missing_completion(self):
        for device in ('mps', 'cuda'):
            voice = self.proof(device=device)
            with self.assertRaisesRegex(ValueError, 'unavailable'):
                verify.collect_voice(self.root, voice, {'python': {'mpsAvailable': False, 'cudaAvailable': False}})
        voice = self.proof(complete=False)
        with self.assertRaisesRegex(ValueError, 'completion'):
            verify.collect_voice(self.root, voice, {'python': {'mpsAvailable': False, 'cudaAvailable': False}})

    def test_rejects_changed_audio_after_production_validation(self):
        voice = self.proof()
        path = self.root / voice / 'speech.wav'
        wav(path, floating=True, rate=24000)
        with self.assertRaisesRegex(ValueError, 'differ'):
            verify.collect_voice(self.root, voice, {'python': {'mpsAvailable': False, 'cudaAvailable': False}})

    def test_installation_snapshot_detects_changed_content(self):
        source = self.root / 'speech'
        source.mkdir()
        (source / 'model').write_bytes(b'original')
        before = verify.installation_snapshot(source, source)
        (source / 'model').write_bytes(b'replaced')
        self.assertNotEqual(before, verify.installation_snapshot(source, source))


if __name__ == '__main__':
    unittest.main()
