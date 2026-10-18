#!/usr/bin/env python3
"""Check immutable CUDA runtime metadata before it enters the model catalogue."""
import copy
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location('speech_catalog', Path(__file__).with_name('optional-speech-catalog.py'))
CATALOG = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CATALOG)
BASE = 'https://github.com/ecojust/open-media/releases/download/speech-runtime-cuda-v1/'


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
