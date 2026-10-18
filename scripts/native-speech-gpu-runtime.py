#!/usr/bin/env python3
"""Build a separate, immutable native GPU component; never replace the CPU runtime."""
from __future__ import annotations

import argparse
import array
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import time
import wave
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'scripts'
TEXT = '这是一款全程由AI接管并生成的软件'


def provenance():
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    return dict(sourceCommit=commit, runnerSourceSha256=common.sha256(SCRIPT / 'speech-runtime-runner.c'),
                builderSourceSha256=common.sha256(Path(__file__)),
                sourceLockSha256=common.sha256(SCRIPT / 'native-speech-gpu-runtime.lock.json'))


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


common = module('optional_runtime_builder', SCRIPT / 'optional-speech-runtime-build.py')
native = module('native_speech_smoke', SCRIPT / 'optional-speech-zip-smoke.py')


def run(command, log, *, cwd=None, env=None, timeout=1800):
    log.parent.mkdir(parents=True, exist_ok=True)
    common.run([str(x) for x in command], log, cwd=cwd or ROOT, env=env, timeout=timeout)


def safe_archive_member(name):
    return common.relative(name)


def extract_file(source, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open('wb') as output:
        shutil.copyfileobj(source, output)


def copy_distinct(source, destination):
    if destination.exists():
        if common.sha256(source) != common.sha256(destination):
            raise ValueError(f'Conflicting native dependency: {destination.name}')
        return
    shutil.copy2(source, destination)


def windows_dependencies(root, report):
    """Reject undeclared toolkit dependencies, including delay-load imports."""
    tool = shutil.which('dumpbin.exe')
    if not tool:
        raise ValueError('The native dependency inspector is required')
    system = {
        'kernel32.dll', 'kernelbase.dll', 'ntdll.dll', 'advapi32.dll', 'user32.dll',
        'gdi32.dll', 'ole32.dll', 'oleaut32.dll', 'shell32.dll', 'shlwapi.dll',
        'ws2_32.dll', 'rpcrt4.dll', 'bcrypt.dll', 'bcryptprimitives.dll', 'crypt32.dll',
        'secur32.dll', 'userenv.dll', 'powrprof.dll', 'version.dll', 'psapi.dll',
        'normaliz.dll', 'setupapi.dll', 'ucrtbase.dll', 'winmm.dll', 'comdlg32.dll',
        'dbghelp.dll', 'cfgmgr32.dll', 'iphlpapi.dll', 'imm32.dll', 'msvcrt.dll',
        'wintrust.dll', 'nvcuda.dll', 'dxgi.dll', 'd3d12.dll',
    }
    bundled = {path.name.lower() for path in (root / 'bin').glob('*.dll')}
    records = []
    for path in sorted((root / 'bin').iterdir()):
        if path.suffix.lower() not in ('.dll', '.exe'):
            continue
        result = subprocess.run([tool, '/nologo', '/dependents', str(path)], capture_output=True,
                                text=True, encoding='utf-8', errors='replace', check=True)
        names = sorted(set(re.findall(r'^\s+([a-zA-Z0-9_.-]+\.dll)\s*$', result.stdout, re.M)))
        missing = [name for name in names if name.lower() not in bundled | system
                   and not name.lower().startswith(('api-ms-win-', 'ext-ms-win-'))]
        if missing:
            raise ValueError(f'Unbundled native dependency in {path.name}: {missing}')
        records.append(dict(path=path.relative_to(root).as_posix(), dependencies=names))
    common.write_json(report, dict(schema=1, dependencies=records,
                                  externalRequirement='Operating system and compatible graphics driver only'))


def verify_provider_load(executable, log):
    # ORT must initialize its shared ProviderHost before loading the CUDA DLL.
    # Direct ctypes/LoadLibrary calls bypass that contract and fail in DllMain.
    # Any official registration error is still fatal, even on a CPU-only host.
    run([executable, '--self-test-provider-load'], log)
    records = [json.loads(line) for line in log.read_text(encoding='utf-8').splitlines()
               if line.startswith('{')]
    expected = dict(provider='cuda', providerLoadVerified=True, gpuInferenceVerified=False,
                    selfTest='official-provider-registration')
    if records != [expected]:
        raise ValueError('The native CUDA provider did not pass official registration')
    return records[0]


def build(args, lock, root):
    if os.name != 'nt':
        raise ValueError('Build the Windows GPU component on Windows')
    if root.exists():
        raise ValueError('Use a fresh work directory; do not overwrite an existing runtime')
    (root / 'bin').mkdir(parents=True)
    (root / 'licenses').mkdir()
    downloads = args.work / 'downloads'
    downloads.mkdir(exist_ok=True)
    engine = lock['engine']
    archive = downloads / 'native-cuda.tar.bz2'
    common.download(engine, archive)
    source = args.work / 'engine'
    keep = {'onnxruntime.dll', 'onnxruntime_providers_shared.dll', 'onnxruntime_providers_cuda.dll',
            'sherpa-onnx-c-api.dll', 'sherpa-onnx-c-api.lib'}
    with tarfile.open(archive) as packed:
        for item in packed:
            safe_archive_member(item.name)
            if item.isdir():
                continue
            prefix = engine['directory'] + '/'
            if not item.name.startswith(prefix):
                raise ValueError('Unexpected engine archive root')
            relative = item.name[len(prefix):]
            if item.isfile() and (relative.startswith('include/') or
                                  relative.startswith('lib/') and Path(relative).name in keep):
                extract_file(packed.extractfile(item), source / safe_archive_member(relative))
    for name in keep - {'sherpa-onnx-c-api.lib'}:
        shutil.copy2(source / 'lib' / name, root / 'bin' / name)
        (source / 'lib' / name).unlink()
    archive.unlink()
    source_lock = json.loads((SCRIPT / 'speech-runtime.lock.json').read_text(encoding='utf-8'))
    headers = next(item for item in source_lock['sources'] if item['id'] == 'onnxruntime')
    headers_archive = downloads / headers['archive']
    common.download(dict(headers, size=headers['bytes']), headers_archive)
    includes = args.work / 'ort-include'
    with tarfile.open(headers_archive) as packed:
        for item in packed:
            if item.isfile() and '/include/onnxruntime/core/session/' in item.name and item.name.endswith('.h'):
                extract_file(packed.extractfile(item), includes / Path(item.name).name)
    headers_archive.unlink()
    for dependency in lock['dependencies']:
        archive = downloads / dependency['filename']
        common.download(dependency, archive)
        license_count, dll_count = 0, 0
        with zipfile.ZipFile(archive) as packed:
            for item in packed.infolist():
                safe_archive_member(item.filename.rstrip('/'))
                if item.is_dir():
                    continue
                name = Path(item.filename).name
                if name.lower().endswith('.dll'):
                    temporary = args.work / 'dependency' / name
                    extract_file(packed.open(item), temporary)
                    copy_distinct(temporary, root / 'bin' / name)
                    temporary.unlink()
                    dll_count += 1
                elif re.search(r'(license|eula|copyright|notice)', name, re.I) or name == 'METADATA':
                    extract_file(packed.open(item), root / 'licenses' / dependency['name'] / safe_archive_member(item.filename))
                    license_count += 1
        if not dll_count or not license_count:
            raise ValueError(f'Missing native code or redistribution notices: {dependency["name"]}')
        archive.unlink()  # The verified DLL tree and provenance retain the needed content.
    shutil.copytree(ROOT / 'licenses/speech-runtime', root / 'licenses/native-engine')
    shutil.copy2(SCRIPT / 'native-speech-gpu-runtime.lock.json', root / 'licenses/component-source-lock.json')
    shutil.copy2(SCRIPT / 'speech-runtime.lock.json', root / 'licenses/engine-source-lock.json')
    definition = args.work / 'onnxruntime.def'
    definition.write_text('LIBRARY onnxruntime.dll\nEXPORTS\nOrtGetApiBase\n', encoding='utf-8')
    import_library = args.work / 'onnxruntime.lib'
    run(['lib.exe', '/nologo', f'/def:{definition}', '/machine:x64', f'/out:{import_library}'],
        args.output / 'logs/import-library.log')
    run(['cl.exe', '/nologo', '/O2', '/MT', '/utf-8', '/std:c11', '/DOPEN_MEDIA_ORT_PROVIDER_QUERY=1',
         f'/I{source / "include"}', f'/I{includes}', SCRIPT / 'speech-runtime-runner.c',
         f'/Fe:{root / lock["executable"]}', f'/Fo:{args.work / "runner.obj"}',
         source / 'lib/sherpa-onnx-c-api.lib', import_library, '/link', '/MANIFEST:EMBED',
         f'/MANIFESTINPUT:{SCRIPT / "speech-runtime-runner.manifest"}'], args.output / 'logs/compile.log')
    common.complete_windows_runtime(root, args.output / 'logs/native-crt.json', executable_directory='bin')
    windows_dependencies(root, root / 'licenses/dependency-closure.json')
    provider_load = verify_provider_load(root / lock['executable'], args.output / 'logs/load-libraries.log')
    run([root / lock['executable'], '--self-test'], args.output / 'logs/self-test.log')
    records = [json.loads(line) for line in (args.output / 'logs/self-test.log').read_text().splitlines()
               if line.startswith('{')]
    if len(records) != 1 or records[0]['provider'] != 'cuda' or records[0]['gpuInferenceVerified'] is not False:
        raise ValueError('The GPU component did not report its actual compiled provider')
    # GetApi(ORT_API_VERSION) must have succeeded for the CUDA inventory above.
    # The GPU archive filename and the pinned header source both require 1.28.2.
    common.write_json(root / 'licenses/build-provenance.json', dict(provenance(),
                      ortSourceVersion=headers['version'], providerSelfTest=records[0],
                      providerLoadTest=provider_load))


def audio_result(path, sample_rate):
    with wave.open(str(path), 'rb') as stream:
        if (stream.getnchannels(), stream.getsampwidth(), stream.getframerate()) != (1, 2, sample_rate):
            raise ValueError('Invalid generated audio format')
        samples = array.array('h', stream.readframes(stream.getnframes()))
    if sys.byteorder != 'little':
        samples.byteswap()
    rms = math.sqrt(sum((value / 32768) ** 2 for value in samples) / max(len(samples), 1))
    if len(samples) < sample_rate / 10 or not math.isfinite(rms) or rms < 1e-5:
        raise ValueError('Silent or incomplete generated audio')
    return dict(sampleRate=sample_rate, sampleCount=len(samples), rms=rms,
                sha256=common.sha256(path), bytes=path.stat().st_size)


def attempt_voice(gpu, cpu, arguments, output, cwd, sample_rate):
    wav = output.with_suffix('.wav')
    command = [str(gpu), *arguments, f'--output-filename={wav}']
    attempts = []
    for index in range(2):
        began = time.monotonic()
        result = subprocess.run(command, cwd=cwd, capture_output=True, text=True,
                                encoding='utf-8', errors='replace', timeout=1800)
        text = result.stdout + result.stderr
        output.with_suffix(f'.attempt{index}.log').write_text(text, encoding='utf-8')
        state = native.native_device_state(text)
        attempts.append(dict(backend=state['backend'], exitCode=result.returncode,
                             elapsedSeconds=time.monotonic() - began))
        if result.returncode == 0:
            if state['backend'] not in ('cpu', 'cuda') or 'stage=complete' not in text:
                raise ValueError('Native synthesis did not report completion and its backend')
            return dict(audio_result(wav, sample_rate), actualDevice=state['backend'], attempts=attempts,
                        fallback=len(attempts) > 1, gpuInferenceVerified=False,
                        gpuEvidence='Provider selection only; operator placement was not profiled')
        if index or state['backend'] != 'cuda' or state['writing']:
            raise ValueError(f'Native voice failed; see {output.name}.attempt{index}.log')
        wav.unlink(missing_ok=True)
        command = [str(cpu), *arguments, '--provider=cpu', f'--output-filename={wav}']
    raise AssertionError('Unreachable')


def validate(args, lock, root):
    cpu_root = args.work / 'cpu-speech'
    run(['node', SCRIPT / 'speech-runtime.mjs', 'prepare', '--directory', cpu_root], args.output / 'logs/cpu-prepare.log')
    cpu_manifest = json.loads((cpu_root / 'manifest.json').read_text(encoding='utf-8'))
    cpu = cpu_root / cpu_manifest['executable']
    gpu = root / lock['executable']
    text = args.output / 'validation/中文 测试文本.txt'
    text.parent.mkdir(parents=True, exist_ok=True)
    text.write_text(TEXT, encoding='utf-8')
    model = cpu_manifest['model']
    flags = [f'--text-file={text}', '--speed=1', '--sid=0']
    matcha = [f'--matcha-{name}={cpu_root / model[field]}' for field, name in
              [('file', 'acoustic-model'), ('vocoder', 'vocoder'), ('tokens', 'tokens'), ('dataDir', 'data-dir')]]
    matcha += ['--matcha-lexicon=' + ','.join(str(cpu_root / p) for p in model['lexicons']),
               '--tts-rule-fsts=' + ','.join(str(cpu_root / p) for p in model['ruleFsts'])]
    results = [dict(voiceId='matcha_zh_en_female', **attempt_voice(gpu, cpu, flags + matcha,
                    text.parent / 'matcha_zh_en_female', cpu_root, 16000))]
    catalog = json.loads((ROOT / 'src-tauri/resources/speech-models.json').read_text(encoding='utf-8'))
    package = next(item for item in catalog['models'] if item['id'] == 'zipvoice-distill-fp32')
    model_root = args.work / '模型 文件'
    for item in package['files']:
        native.download(item, native.safe_path(model_root, item['path']), SCRIPT / 'optional-speech-assets', [])
    config = package['model']
    def resource(path):
        return cpu_root / path[len('@bundled/'):] if path.startswith('@bundled/') else model_root / path
    zip_flags = [f'--zipvoice-{name}={resource(config[field])}' for field, name in
                 [('encoder', 'encoder'), ('decoder', 'decoder'), ('vocoder', 'vocoder'),
                  ('tokens', 'tokens'), ('dataDir', 'data-dir')]]
    zip_flags += ['--zipvoice-lexicon=' + ','.join(str(resource(p)) for p in config['lexicons']), '--num-steps=8']
    for gender in ('female', 'male'):
        reference_audio = resource(config['referenceAudio']) if gender == 'female' else SCRIPT / 'optional-speech-assets/male-reference.wav'
        reference_text = resource(config['referenceText']) if gender == 'female' else SCRIPT / 'optional-speech-assets/male-reference.txt'
        voice = f'zipvoice_zh_{gender}'
        result = attempt_voice(gpu, cpu, flags + zip_flags + [f'--reference-audio={reference_audio}',
                    f'--reference-text-file={reference_text}'], text.parent / voice, cpu_root, 24000)
        results.append(dict(voiceId=voice, **result))
    proof = dict(schema=1, status='passed', text=TEXT, voices=results,
                 gpuInferenceVerified=False, pathCoverage='relocated non-ASCII and spaces',
                 meaning='Real native synthesis and CPU fallback; no claim of GPU hardware validation')
    common.write_json(args.output / 'validation.json', proof)
    return proof


def package(args, lock, root, proof):
    files = []
    for path in sorted(root.rglob('*')):
        if path.is_symlink():
            raise ValueError('Native runtime must not contain symlinks')
        if path.is_file():
            files.append(dict(path=path.relative_to(root).as_posix(), size=path.stat().st_size,
                              sha256=common.sha256(path), executable=path.suffix.lower() in ('.exe', '.dll')))
    common.write_json(root / 'manifest.json', dict(schema=1, files=files))
    archive = args.output / f'open-media-native-cuda-v1-{lock["platform"]}.zip'
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as target:
        for path in sorted(root.rglob('*')):
            if path.is_file():
                target.write(path, path.relative_to(root).as_posix())
    metadata = dict(id=lock['id'], version=lock['version'], kind='native', platform=lock['platform'], filename=archive.name,
                    size=archive.stat().st_size, sha256=common.sha256(archive),
                    unpackedSize=sum(item['size'] for item in files) + (root / 'manifest.json').stat().st_size,
                    manifestSha256=common.sha256(root / 'manifest.json'), executable=lock['executable'],
                    script=lock['executable'], validated=True,
                    validatedModels=['matcha-icefall-zh-en', 'zipvoice-distill-fp32'],
                    validatedVoices=[item['voiceId'] for item in proof['voices']],
                    gpuInferenceVerified=False, validation=proof, **provenance())
    unpacked = args.work / 'archive-check'
    # Decompress and hash every ZIP member without retaining a second large DLL
    # tree. The relocated tree must match that same complete manifest exactly.
    common.verify_archive_payload(archive, metadata)
    root.rename(unpacked)
    common.verify_tree(unpacked, metadata)
    run([unpacked / lock['executable'], '--self-test'], args.output / 'logs/archive-self-test.log')
    verify_provider_load(unpacked / lock['executable'], args.output / 'logs/archive-provider-load.log')
    common.verify_tree(unpacked, metadata)
    shutil.rmtree(unpacked)
    metadata = common.split_archive(archive, metadata, lock['releaseTag'])
    common.write_json(args.output / 'runtime-metadata.json', metadata)
    (args.output / 'SHA256SUMS.txt').write_text(''.join(f'{p["sha256"]}  {p["filename"]}\n' for p in metadata['parts']), encoding='utf-8')


def sources(args):
    stage = args.work / 'native-gpu-corresponding-source'
    stage.mkdir(parents=True, exist_ok=True)
    source_lock = json.loads((SCRIPT / 'speech-runtime.lock.json').read_text(encoding='utf-8'))
    for item in source_lock['sources']:
        if item['kind'] == 'source':
            common.download(dict(item, size=item['bytes']), stage / 'downloads' / item['archive'])
    for name in ['native-speech-gpu-runtime.py', 'native-speech-gpu-runtime.lock.json',
                 'optional-speech-runtime-build.py', 'optional-speech-zip-smoke.py', 'speech-runtime.mjs',
                 'speech-runtime.lock.json', 'speech-runtime-runner.c', 'speech-runtime-runner.manifest']:
        destination = stage / 'scripts' / name
        destination.parent.mkdir(exist_ok=True)
        shutil.copy2(SCRIPT / name, destination)
    shutil.copytree(ROOT / 'licenses', stage / 'licenses')
    shutil.copytree(SCRIPT / 'optional-speech-assets', stage / 'scripts/optional-speech-assets')
    shutil.copytree(SCRIPT / 'optional-speech-runtime-licenses', stage / 'scripts/optional-speech-runtime-licenses')
    catalog = stage / 'src-tauri/resources/speech-models.json'
    catalog.parent.mkdir(parents=True)
    shutil.copy2(ROOT / 'src-tauri/resources/speech-models.json', catalog)
    shutil.copy2(ROOT / 'LICENSE', stage / 'LICENSE')
    workflow = stage / '.github/workflows/native-speech-gpu-runtime.yml'
    workflow.parent.mkdir(parents=True)
    shutil.copy2(ROOT / '.github/workflows/native-speech-gpu-runtime.yml', workflow)
    (stage / 'README.txt').write_text('Native GPU component corresponding source and pinned engine build inputs.\n'
        'Original engine/ORT sources and their exact upstream GPU workflows are included in downloads.\n'
        'The engine uses SHERPA_ONNX_ENABLE_GPU=ON, ONNX Runtime 1.28.2 and CUDA 12 with cuDNN 9.\n'
        'scripts/native-speech-gpu-runtime.py records exact helper compilation, library assembly and validation.\n'
        'Dependency download URLs and hashes are immutable; all redistribution notices remain in the binary package.\n', encoding='utf-8')
    archive = args.output / 'open-media-native-cuda-v1-corresponding-source.tar.gz'
    with tarfile.open(archive, 'w:gz') as packed:
        packed.add(stage, arcname=stage.name)
    common.write_json(args.output / 'source-metadata.json', dict(filename=archive.name,
                      size=archive.stat().st_size, sha256=common.sha256(archive), **provenance()))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--work', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--phase', choices=('all', 'sources'), default='all')
    args = parser.parse_args()
    args.work, args.output = args.work.resolve(), args.output.resolve()
    args.work.mkdir(parents=True, exist_ok=True)
    args.output.mkdir(parents=True, exist_ok=True)
    if args.phase == 'sources':
        sources(args)
        return
    lock = json.loads((SCRIPT / 'native-speech-gpu-runtime.lock.json').read_text(encoding='utf-8'))
    root = args.work / 'runtime'
    build(args, lock, root)
    relocated = args.work / '移动验证 中文 空格/运行组件'
    relocated.parent.mkdir(parents=True)
    root.rename(relocated)
    before = {p.relative_to(relocated).as_posix(): common.sha256(p) for p in relocated.rglob('*') if p.is_file()}
    proof = validate(args, lock, relocated)
    after = {p.relative_to(relocated).as_posix(): common.sha256(p) for p in relocated.rglob('*') if p.is_file()}
    if before != after:
        raise ValueError('Native inference changed the installed component')
    package(args, lock, relocated, proof)


if __name__ == '__main__':
    main()
