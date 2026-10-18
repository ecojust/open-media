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


def safe_relative(value):
    if (not isinstance(value, str) or not value or '\\' in value or ':' in value
            or any(part in ('', '.', '..') for part in value.split('/'))):
        raise ValueError(f'Unsafe model file path: {value}')
    return value


def checked_url(value):
    if not isinstance(value, str):
        raise ValueError('Model download URL must be a string.')
    parsed = urlsplit(value)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError('Model downloads must use public HTTPS URLs.')


def build_models(source):
    """Retain the reviewed production file pins; never reconstruct model provenance."""
    document = json.loads(source.read_text(encoding='utf-8'))
    expected = {'zipvoice-distill-fp32': 'zipvoice', 'f5-v1-base-fp32': 'f5',
                'qwen3-tts-1.7b-serena': 'qwen3'}
    models = document.get('models', [])
    if (document.get('schema') != 2 or not isinstance(models, list)
            or len(models) != len(expected)
            or {model.get('id') for model in models if isinstance(model, dict)} != set(expected)):
        raise ValueError('Model catalogue must contain the reviewed production model records.')
    voice_ids = set()
    for model in models:
        config = model.get('model', {})
        if model.get('version') != 1 or not isinstance(config, dict) or config.get('kind') != expected[model['id']]:
            raise ValueError(f'Unexpected model identity or implementation: {model["id"]}')
        if not isinstance(model.get('license'), str) or not model['license']:
            raise ValueError('Model licence information is required.')
        files = model.get('files', [])
        if not isinstance(files, list) or not files:
            raise ValueError('Model files are required.')
        paths = set()
        for file in files:
            if not isinstance(file, dict):
                raise ValueError('Model file records must be objects.')
            path = safe_relative(file.get('path'))
            if path in paths:
                raise ValueError(f'Duplicate model file: {path}')
            paths.add(path)
            if (type(file.get('size')) is not int or file['size'] <= 0
                    or not isinstance(file.get('sha256'), str)
                    or not re.fullmatch('[a-f0-9]{64}', file['sha256'])):
                raise ValueError(f'Model files require exact byte sizes and integrity digests: {path}')
            checked_url(file.get('url'))
            mirrors = file.get('mirrors', [])
            if not isinstance(mirrors, list):
                raise ValueError(f'Invalid model alternate sources: {path}')
            for url in mirrors:
                checked_url(url)
            if len(mirrors) != len(set(mirrors)):
                raise ValueError(f'Duplicate model alternate sources: {path}')
            if 'embedded' in file:
                embedded = ASSETS / safe_relative(file['embedded'])
                data = embedded.read_bytes()
                if len(data) != file['size'] or hashlib.sha256(data).hexdigest() != file['sha256']:
                    raise ValueError(f'Embedded model resource differs from its reviewed file pin: {path}')
        if (model.get('modelSize') != sum(file['size'] for file in files)
                or model.get('downloadSize') != sum(file['size'] for file in files if not file.get('embedded'))):
            raise ValueError(f'Model byte totals do not match pinned files: {model["id"]}')
        lexicons = config.get('lexicons', [])
        if not isinstance(lexicons, list):
            raise ValueError('Model lexicons must be a list of pinned paths.')
        required = ([config.get(key) for key in ['encoder', 'decoder', 'tokens', 'vocoder', 'referenceAudio', 'referenceText']]
                    + lexicons if config['kind'] == 'zipvoice' else [config.get('config')])
        if not required or any(not isinstance(path, str) or path not in paths for path in required):
            raise ValueError(f'Model configuration refers to an unpinned file: {model["id"]}')
        voices = model.get('voices', [])
        if not isinstance(voices, list) or not voices:
            raise ValueError('The reviewed model voices are required.')
        for voice in voices:
            if not isinstance(voice, dict):
                raise ValueError('Model voice records must be objects.')
            identity = voice.get('id')
            if not isinstance(identity, str) or not identity or identity in voice_ids:
                raise ValueError('Model voice identifiers must be present and unique.')
            voice_ids.add(identity)
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
    parser.add_argument('--model-catalog', type=Path, required=True,
                        help='Reviewed production model catalogue with exact existing file pins.')
    parser.add_argument('--runtime-metadata', type=Path,
                        help='Verified release metadata JSON or a directory of platform metadata.')
    parser.add_argument('--accelerated-runtime-metadata', type=Path,
                        help='Verified Windows CUDA runtime metadata; existing CPU and MPS runtime records are preserved.')
    parser.add_argument('--native-runtime-metadata', type=Path,
                        help='Verified native acceleration runtime metadata; bundled CPU resources are preserved.')
    parser.add_argument('--models-only', action='store_true',
                        help='Bootstrap model records before the first runtime build; not an application-ready catalogue.')
    parser.add_argument('--output', type=Path, default=ROOT / 'src-tauri/resources/speech-models.json')
    args = parser.parse_args()
    if not args.models_only and args.runtime_metadata is None:
        parser.error('--runtime-metadata is required for an application-ready catalogue.')
    source_catalogue = json.loads(args.model_catalog.read_text(encoding='utf-8'))
    if (not args.models_only and source_catalogue.get('nativeAccelerationRuntimeId')
            and not args.native_runtime_metadata):
        parser.error('--native-runtime-metadata is required to retain the existing native acceleration runtime.')
    catalogue = dict(schema=2, models=build_models(args.model_catalog), runtimes=[])
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
        available = {runtime['id'] for runtime in catalogue['runtimes']}
        for model in catalogue['models']:
            for field in ['runtimeId', 'acceleratedRuntimeId']:
                if model.get(field) and model[field] not in available:
                    raise ValueError(f'Missing verified runtime metadata for {model[field]}.')

    args.output.write_text(json.dumps(catalogue, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'Wrote {args.output}; runtime metadata: {bool(catalogue["runtimes"])}')


if __name__ == '__main__':
    main()
