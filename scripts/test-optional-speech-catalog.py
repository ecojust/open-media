#!/usr/bin/env python3
"""Check immutable CUDA runtime metadata before it enters the model catalogue."""
import copy
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location('speech_catalog', Path(__file__).with_name('optional-speech-catalog.py'))
CATALOG = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CATALOG)
BASE = 'https://github.com/ecojust/open-media/releases/download/speech-runtime-cuda-v1/'


class ProductionModelCatalogTests(unittest.TestCase):
    def setUp(self):
        self.source = CATALOG.ROOT / 'src-tauri/resources/speech-models.json'
        self.document = json.loads(self.source.read_text(encoding='utf-8'))

    def load(self, data):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / 'models.json'
            source.write_text(json.dumps(data), encoding='utf-8')
            return CATALOG.build_models(source)

    def test_preserves_existing_model_pins_voices_and_download_sources_exactly(self):
        self.assertEqual(CATALOG.build_models(self.source), self.document['models'])

    def test_rejects_invalid_pins_paths_embedded_bytes_and_configuration(self):
        for field, value in [('path', '../outside'), ('size', 0), ('size', True),
                             ('sha256', 'bad'), ('url', 'http://example.com/model')]:
            document = copy.deepcopy(self.document)
            document['models'][0]['files'][0][field] = value
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                self.load(document)
        for mutation in ['duplicate-file', 'embedded-hash', 'model-total', 'config-file', 'duplicate-voice']:
            document = copy.deepcopy(self.document)
            model = document['models'][0]
            if mutation == 'duplicate-file':
                model['files'].append(copy.deepcopy(model['files'][0]))
            elif mutation == 'embedded-hash':
                next(file for file in model['files'] if file.get('embedded'))['sha256'] = '0' * 64
            elif mutation == 'model-total':
                model['modelSize'] += 1
            elif mutation == 'config-file':
                model['model']['encoder'] = 'not-pinned.onnx'
            else:
                model['voices'].append(copy.deepcopy(model['voices'][0]))
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                self.load(document)

    def test_cli_requires_explicit_inputs_and_models_only_preserves_pins(self):
        script = Path(__file__).with_name('optional-speech-catalog.py')
        with tempfile.TemporaryDirectory() as root:
            output = Path(root) / 'models-only.json'
            result = subprocess.run([sys.executable, script, '--model-catalog', self.source, '--output', output],
                                    capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('--runtime-metadata', result.stderr)
            self.assertFalse(output.exists())
            result = subprocess.run([sys.executable, script, '--models-only', '--output', output],
                                    capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('--model-catalog', result.stderr)
            result = subprocess.run([sys.executable, script, '--models-only', '--model-catalog', self.source,
                                     '--output', output], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            generated = json.loads(output.read_text(encoding='utf-8'))
            self.assertEqual(generated['models'], self.document['models'])
            self.assertEqual(generated['runtimes'], [])


class CudaCatalogMetadataTests(unittest.TestCase):
    def metadata(self):
        return dict(id='python-cuda-v1', version=1, platform='windows-x64', validated=True,
                    validatedModels=['f5-v1-base-fp32', 'qwen3-tts-1.7b-serena'],
                    sourceCommit='a' * 40, url=BASE + 'speech-runtime-python-cuda-v1-windows-x64.zip',
                    size=3_000_000_000, unpackedSize=6_000_000_000, sha256='b' * 64,
                    manifestSha256='c' * 64, executable='python/python.exe', script='runner/tts.py',
                    mirrors=['https://ghfast.top/' + BASE + 'speech-runtime-python-cuda-v1-windows-x64.zip'],
                    parts=[dict(url=BASE + f'archive.zip.part{index:03}', size=1_500_000_000, sha256=char * 64,
                                mirrors=['https://ghfast.top/' + BASE + f'archive.zip.part{index:03}'])
                           for index, char in enumerate(['d', 'e'])])

    def load(self, data):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / 'runtime-metadata.json'
            source.write_text(json.dumps(data), encoding='utf-8')
            return CATALOG.runtime_platforms(source, identity='python-cuda-v1', required={'windows-x64'}, release=BASE)

    def test_accepts_true_platform_identity_and_retains_parts(self):
        data = self.metadata()
        result = self.load(data)
        self.assertEqual(set(result), {'windows-x64'})
        self.assertEqual(result['windows-x64']['parts'], data['parts'])

    def test_rejects_unvalidated_wrong_identity_and_mutable_release(self):
        for key, value in [('id', 'python-cpu-v1'), ('validated', False), ('sourceCommit', ''),
                           ('validatedModels', ['f5-v1-base-fp32']), ('url', BASE.replace('-cuda-v1', '-v1') + 'runtime.zip')]:
            data = self.metadata()
            data[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.load(data)

    def test_rejects_corrupt_oversize_and_unsafe_parts(self):
        for key, value in [('size', 1_800_000_001), ('sha256', 'no digest'), ('url', 'file:///tmp/part')]:
            data = self.metadata()
            data['parts'][0][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.load(data)
        for mutation in ['missing', 'duplicate', 'too-many']:
            data = self.metadata()
            if mutation == 'missing':
                data['parts'].pop()
            elif mutation == 'duplicate':
                data['parts'][1]['url'] = data['parts'][0]['url']
            else:
                data['parts'] = [copy.deepcopy(data['parts'][0]) for _ in range(17)]
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                self.load(data)


class NativeCatalogMetadataTests(CudaCatalogMetadataTests):
    def metadata(self):
        data = super().metadata()
        base = BASE.replace('speech-runtime-cuda-v1', 'speech-native-cuda-v1')
        data.update(id='native-cuda-v1', kind='native',
                    validatedModels=['matcha-icefall-zh-en', 'zipvoice-distill-fp32'],
                    validatedVoices=['matcha_zh_en_female', 'zipvoice_zh_female', 'zipvoice_zh_male'],
                    executable='bin/open-media-speech.exe', script='',
                    url=base + 'open-media-native-cuda-v1-windows-x64.zip')
        data['mirrors'] = ['https://ghfast.top/' + data['url']]
        for part in data['parts']:
            part['url'] = part['url'].replace(BASE, base)
            part['mirrors'] = [value.replace(BASE, base) for value in part['mirrors']]
        return data

    def load(self, data):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / 'runtime-metadata.json'
            source.write_text(json.dumps(data), encoding='utf-8')
            return CATALOG.runtime_platforms(
                source, identity='native-cuda-v1', required={'windows-x64'}, kind='native',
                filename_prefix='open-media',
                validated_models={'matcha-icefall-zh-en', 'zipvoice-distill-fp32'},
                release=BASE.replace('speech-runtime-cuda-v1', 'speech-native-cuda-v1'))

    def test_rejects_missing_voice_validation_and_wrong_runtime_kind(self):
        for key, value in [('kind', 'python'), ('version', None),
                           ('validatedVoices', ['matcha_zh_en_female', 'zipvoice_zh_female'])]:
            data = self.metadata()
            data[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.load(data)
        self.assertEqual(self.load(self.metadata())['windows-x64']['kind'], 'native')

    def test_split_assets_require_mirrors_for_each_real_download(self):
        data = self.metadata()
        data.pop('mirrors')
        self.assertEqual(self.load(data)['windows-x64']['mirrors'], [])
        data['parts'][1].pop('mirrors')
        with self.assertRaises(ValueError):
            self.load(data)


if __name__ == '__main__':
    unittest.main()
