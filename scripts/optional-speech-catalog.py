#!/usr/bin/env python3
"""Build the downloadable model catalogue from pinned, reviewed inputs."""
import argparse
import hashlib
import json
import re
from pathlib import Path
from urllib.parse import urlsplit

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
                        'Apache-2.0', '中文男声与女声；本地离线合成，建议至少 16 GB 内存。', 'python-cpu-v1')
    models = [zip_model, f5_model, qwen_model]
    # Both voices use the same verified weights and runtime download. Male
    # reference audio and speaker selection belong to the application adapter.
    for model, voice_id, name in [
        (zip_model, 'zipvoice_zh_male', 'ZipVoice Distill FP32 · 男声'),
        (f5_model, 'f5_zh_male', 'F5-TTS v1 Base FP32 · 男声'),
        (qwen_model, 'qwen3_uncle_fu', 'Qwen3-TTS 1.7B BF16 · 男声'),
    ]:
        model['voices'].append(dict(id=voice_id, name=name, language='zh-CN', gender='male', speakerId=0))
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


def runtime_platforms(source, *, identity="python-cpu-v1", required=None, release=RELEASE,
                      kind="python", validated_models=None, filename_prefix="speech-runtime"):
    files = [source] if source.is_file() else sorted(source.rglob('*.json'))
    platforms = {}
    commits = set()
    required = required or {'macos-arm64', 'macos-x64', 'windows-x64'}
    validated_models = validated_models or {'f5-v1-base-fp32', 'qwen3-tts-1.7b-serena'}
    for file in files:
        document = json.loads(file.read_text(encoding='utf-8'))
        for data in document if isinstance(document, list) else [document]:
            if not isinstance(data, dict) or data.get('platform') not in required:
                continue
            if data.get('id') != identity or data.get('version') != 1:
                raise ValueError(f'Unexpected runtime identity in {file}.')
            if data.get('validated') is not True or set(data.get('validatedModels', [])) != validated_models:
                raise ValueError(f'Runtime metadata has not passed both real speech checks: {file}.')
            commit = data.get('sourceCommit', '')
            if not re.fullmatch('[a-f0-9]{40}', commit):
                raise ValueError(f'Runtime metadata must identify its source commit: {file}.')
            commits.add(commit)
            archive = {key: data[key] for key in
                       ['url', 'size', 'unpackedSize', 'sha256', 'manifestSha256', 'executable', 'script']}
            parts = data.get('parts', [])
            mirrors = data.get('mirrors', [])
            if not isinstance(mirrors, list) or (not mirrors and not parts) or len(set(mirrors)) != len(mirrors):
                raise ValueError(f'Runtime metadata must include independently verified alternate sources: {file}.')
            archive['mirrors'] = mirrors
            if data.get('kind', 'python') != kind:
                raise ValueError(f'Unexpected inference runtime kind in {file}.')
            if kind == 'native':
                if set(data.get('validatedVoices', [])) != {'matcha_zh_en_female', 'zipvoice_zh_female', 'zipvoice_zh_male'}:
                    raise ValueError(f'Native runtime must verify every supported voice: {file}.')
                archive['kind'] = kind
            if archive['url'] != release + f'{filename_prefix}-{identity}-{data["platform"]}.zip':
                raise ValueError(f'Runtime URL does not match its immutable release: {file}.')
            for url in [archive['url'], *archive.get('mirrors', [])]:
                parsed = urlsplit(url)
                if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
                    raise ValueError(f'Runtime download must use a public HTTPS address: {file}.')
            if not (isinstance(archive['size'], int) and 0 < archive['size'] <= archive['unpackedSize']):
                raise ValueError(f'Invalid runtime byte sizes: {file}.')
            if any(not re.fullmatch('[a-f0-9]{64}', archive[key]) for key in ['sha256', 'manifestSha256']):
                raise ValueError(f'Invalid runtime integrity digest: {file}.')
            if parts:
                if not isinstance(parts, list) or len(parts) > 16:
                    raise ValueError(f'Runtime archive has too many parts: {file}.')
                total = 0
                urls = set()
                for part in parts:
                    if (not isinstance(part, dict) or not isinstance(part.get('size'), int)
                            or not 0 < part['size'] <= 1_800_000_000
                            or not re.fullmatch('[a-f0-9]{64}', part.get('sha256', ''))
                            or part.get('url') in urls
                            or not part.get('url', '').startswith(release)):
                        raise ValueError(f'Invalid runtime archive part in {file}.')
                    # Split archives are not published as a single asset. Each
                    # actual download therefore needs its own measured routes.
                    part_mirrors = part.get('mirrors', [])
                    if (not isinstance(part_mirrors, list) or not part_mirrors or len(part_mirrors) > 8
                            or len(set(part_mirrors)) != len(part_mirrors)):
                        raise ValueError(f'Runtime archive part is missing verified alternate sources: {file}.')
                    urls.add(part['url'])
                    for url in [part['url'], *part.get('mirrors', [])]:
                        parsed = urlsplit(url)
                        if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
                            raise ValueError(f'Invalid runtime archive part source in {file}.')
                    total += part['size']
                if total != archive['size']:
                    raise ValueError(f'Runtime archive parts do not match its overall size: {file}.')
                archive['parts'] = parts
            previous = platforms.get(data['platform'])
            if previous is not None and previous != archive:
                raise ValueError(f'Conflicting runtime metadata for {data["platform"]}.')
            platforms[data['platform']] = archive
    if set(platforms) != required or len(commits) != 1:
        raise ValueError('Runtime metadata must include the required platforms from one verified source commit.')
    return platforms


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--runtime-metadata', type=Path,
                        default=ROOT / 'test/optional-speech-runtime/runtime-metadata.json',
                        help='Verified release metadata JSON or a directory of platform metadata.')
    parser.add_argument('--accelerated-runtime-metadata', type=Path,
                        help='Verified Windows CUDA runtime metadata; existing CPU and MPS runtime records are preserved.')
    parser.add_argument('--native-runtime-metadata', type=Path,
                        help='Verified native acceleration runtime metadata; bundled CPU resources are preserved.')
    parser.add_argument('--models-only', action='store_true',
                        help='Bootstrap model records before the first runtime build; not an application-ready catalogue.')
    parser.add_argument('--output', type=Path, default=ROOT / 'src-tauri/resources/speech-models.json')
    args = parser.parse_args()
    for model, name in [('f5-v1-base-fp32', 'f5'), ('qwen3-tts-1.7b-serena', 'qwen3')]:
        data = (ROOT / f'scripts/optional-speech-runner/config/{model}.json').read_bytes()
        (ASSETS / f'{name}-runner-config.json').write_bytes(data)
    catalogue = dict(schema=2, models=build_models(), runtimes=[])
    if not args.models_only:
        platforms = runtime_platforms(args.runtime_metadata)
        catalogue['runtimes'] = [dict(id='python-cpu-v1', version=1, platforms=platforms)]
        if args.accelerated_runtime_metadata:
            identity = 'python-cuda-v1'
            accelerated = runtime_platforms(args.accelerated_runtime_metadata, identity=identity,
                                           required={'windows-x64'},
                                           release='https://github.com/ecojust/open-media/releases/download/speech-runtime-cuda-v1/')
            catalogue['runtimes'].append(dict(id=identity, version=1, platforms=accelerated))
            for model in catalogue['models']:
                if model.get('runtimeId') == 'python-cpu-v1':
                    model['acceleratedRuntimeId'] = identity
        if args.native_runtime_metadata:
            identity = 'native-cuda-v1'
            native = runtime_platforms(args.native_runtime_metadata, identity=identity,
                                       required={'windows-x64'}, kind='native', filename_prefix='open-media',
                                       validated_models={'matcha-icefall-zh-en', 'zipvoice-distill-fp32'},
                                       release='https://github.com/ecojust/open-media/releases/download/speech-native-cuda-v1/')
            catalogue['runtimes'].append(dict(id=identity, version=1, platforms=native))
            catalogue['nativeAccelerationRuntimeId'] = identity

    args.output.write_text(json.dumps(catalogue, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'Wrote {args.output}; runtime metadata: {bool(catalogue["runtimes"])}')


if __name__ == '__main__':
    main()
