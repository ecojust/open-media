#!/usr/bin/env python3
"""Build the downloadable model catalogue from pinned, reviewed inputs."""
import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'scripts/optional-speech-assets'
RELEASE = 'https://github.com/ecojust/open-media/releases/download/speech-runtime-v1/'
BENCHMARK = ROOT / 'test/chinese-tts-benchmark/manifests'


def local_file(source, destination=None):
    path = ASSETS / source
    data = path.read_bytes()
    return {'path': destination or source, 'url': RELEASE + source, 'embedded': source,
            'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


def remote_file(path, url, size, sha256):
    return dict(path=path, url=url, size=size, sha256=sha256)


def package(model_id, name, voice_id, files, model, license, usage_note, runtime=None):
    result = dict(id=model_id, version=1, license=license, usageNote=usage_note,
                  modelSize=sum(f['size'] for f in files),
                  downloadSize=sum(f['size'] for f in files if not f.get('embedded')),
                  voices=[dict(id=voice_id, name=name, language='zh-CN', gender='female', speakerId=0)],
                  files=files, model=model)
    if runtime:
        result['runtimeId'] = runtime
    return result


def build_models():
    zip_source = json.loads((BENCHMARK / 'zipvoice-distill-fp32-zh-frontend.json').read_text())
    zip_files = {f['path']: f for f in zip_source['model_files']}
    zip_base = 'https://huggingface.co/k2-fsa/ZipVoice/resolve/889dd609a42f0de9cf9aac335eae42677becb1b9/zipvoice_distill/'
    files = [remote_file(dest, zip_base + source, zip_files[dest]['bytes'], zip_files[dest]['sha256'])
             for dest, source in [('encoder.onnx', 'text_encoder.onnx'), ('decoder.onnx', 'fm_decoder.onnx'), ('tokens.txt', 'tokens.txt')]]
    source = zip_source['source']
    files += [remote_file('vocos_24khz.onnx', source['vocoder'], source['vocoder_bytes'], source['vocoder_sha256']),
              local_file('zipvoice-lexicon.txt', 'lexicon.txt'),
              local_file('zipvoice-reference.wav', 'reference.wav'),
              local_file('zipvoice-reference.txt', 'reference.txt')]
    zip_model = package('zipvoice-distill-fp32', 'ZipVoice Distill FP32', 'zipvoice_zh_female', files,
                        dict(kind='zipvoice', encoder='encoder.onnx', decoder='decoder.onnx',
                             tokens='tokens.txt', vocoder='vocos_24khz.onnx',
                             dataDir='@bundled/model/espeak-ng-data', lexicons=['lexicon.txt'],
                             referenceAudio='reference.wav', referenceText='reference.txt', sampleRate=24000),
                        'CC-BY-NC', '模型权重限非商业用途；固定合成参考音色。')

    f5_source = json.loads((BENCHMARK / 'f5-v1-base-fp32.json').read_text())
    f5_files = {f['path']: f for f in f5_source['model_files']}
    f5_base = 'https://huggingface.co/SWivid/F5-TTS/resolve/84e5a410d9cead4de2f847e7c9369a6440bdfaca/F5TTS_v1_Base/'
    vocos_base = 'https://huggingface.co/charactr/vocos-mel-24khz/resolve/0feb3fdd929bcd6649e0e7c5a688cf7dd012ef21/'
    files = []
    for path, key, url in [('model_1250000.safetensors', 'models/f5/model_1250000.safetensors', f5_base + 'model_1250000.safetensors'),
                           ('vocab.txt', 'models/f5/vocab.txt', f5_base + 'vocab.txt'),
                           ('vocos/pytorch_model.bin', 'models/vocos/pytorch_model.bin', vocos_base + 'pytorch_model.bin'),
                           ('vocos/config.yaml', 'models/vocos/config.yaml', vocos_base + 'config.yaml')]:
        info = f5_files[key]
        files.append(remote_file(path, url, info['bytes'], info['sha256']))
    files += [local_file('f5-reference.wav', 'reference.wav'), local_file('f5-reference.txt', 'reference.txt'),
              local_file('f5-runner-config.json', 'runner-config.json')]
    f5_model = package('f5-v1-base-fp32', 'F5-TTS v1 Base FP32', 'f5_zh_female', files,
                       dict(kind='f5', config='runner-config.json', sampleRate=24000),
                       'CC-BY-NC-4.0', '模型权重限非商业用途；固定合成参考音色。', 'python-cpu-v1')

    qwen_source = json.loads((BENCHMARK / 'qwen3-tts-1.7b-serena.json').read_text())
    files = [remote_file(f['path'], f['url'], f['bytes'], f['sha256']) for f in qwen_source['model_files']]
    files.append(local_file('qwen3-runner-config.json', 'runner-config.json'))
    qwen_model = package('qwen3-tts-1.7b-serena', 'Qwen3-TTS 1.7B BF16 · Serena', 'qwen3_serena', files,
                        dict(kind='qwen3', config='runner-config.json', sampleRate=24000),
                        'Apache-2.0', '中文 Serena；CPU 离线合成，建议至少 16 GB 内存。', 'python-cpu-v1')
    models = [zip_model, f5_model, qwen_model]
    audit = json.loads((ROOT / 'scripts/optional-speech-mirror-audit.json').read_text())
    for model in models:
        for file in model['files']:
            mirrors = audit['mappings'].get(file['url'], [])
            if mirrors and mirrors[0].startswith('https://modelscope.cn/'):
                # This source serves the verified files independently of the
                # original storage CDN, which is unreachable on some networks.
                file['url'], file['mirrors'] = mirrors[0], [file['url'], *mirrors[1:]]
            elif mirrors:
                file['mirrors'] = mirrors
    return models


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--runtime-metadata', type=Path, help='Directory containing verified per-platform metadata JSON.')
    parser.add_argument('--output', type=Path, default=ROOT / 'src-tauri/resources/speech-models.json')
    args = parser.parse_args()
    for model, name in [('f5-v1-base-fp32', 'f5'), ('qwen3-tts-1.7b-serena', 'qwen3')]:
        data = (ROOT / f'scripts/optional-speech-runner/config/{model}.json').read_bytes()
        (ASSETS / f'{name}-runner-config.json').write_bytes(data)
    catalogue = dict(schema=2, models=build_models(), runtimes=[])
    if args.runtime_metadata:
        platforms = {}
        for file in sorted(args.runtime_metadata.glob('*.json')):
            data = json.loads(file.read_text())
            if data.get('platform') not in ['macos-arm64', 'macos-x64', 'windows-x64', 'linux-x64']:
                continue
            platforms[data['platform']] = {key: data[key] for key in
                ['url', 'size', 'unpackedSize', 'sha256', 'manifestSha256', 'executable', 'script']}
        required = {'macos-arm64', 'macos-x64', 'windows-x64'}
        if not required.issubset(platforms):
            raise ValueError('Runtime metadata must include all three supported desktop platforms.')
        catalogue['runtimes'] = [dict(id='python-cpu-v1', version=1, platforms=platforms)]
    args.output.write_text(json.dumps(catalogue, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'Wrote {args.output}; runtime metadata: {bool(catalogue["runtimes"])}')


if __name__ == '__main__':
    main()
