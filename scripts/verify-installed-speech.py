#!/usr/bin/env python3
"""Verify all installed voices through the application's real synthesis path.

Downloads only catalog-locked released runtime/model bytes. The installed bundle
is read-only; Unicode job, model and cache paths live outside it. This performs
text-to-speech only and never opens an audio-input or screen-capture device.
"""
from __future__ import annotations

import argparse
import array
import importlib.util
import json
import math
import os
from pathlib import Path
import platform
import shutil
import struct
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('speech_integrity', ROOT / 'scripts/optional-speech-runtime-build.py')
integrity = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(integrity)
TEST = 'speech::tests::real_installed_voice_production_round_trip'
TEXT = '这是一款全程由AI接管并生成的软件'
VOICES = ('matcha_zh_en_female', 'zipvoice_zh_female', 'zipvoice_zh_male',
          'f5_zh_female', 'f5_zh_male', 'qwen3_serena', 'qwen3_uncle_fu')
PLATFORMS = {'macos-arm64': ('Darwin', 'arm64', 'aarch64-apple-darwin'),
             'macos-x64': ('Darwin', 'x86_64', 'x86_64-apple-darwin'),
             'windows-x64': ('Windows', 'amd64', 'x86_64-pc-windows-msvc')}


def inspect_audio(path: Path) -> dict:
    """Decode the entire generated PCM/float WAV without external dependencies."""
    data = path.read_bytes()
    if len(data) < 44 or data[:4] != b'RIFF' or data[8:12] != b'WAVE':
        raise ValueError('Generated output is not a RIFF WAVE file')
    if struct.unpack_from('<I', data, 4)[0] + 8 != len(data):
        raise ValueError('WAV container is incomplete or has trailing bytes')
    position, fmt, audio = 12, None, None
    while position + 8 <= len(data):
        name, size = struct.unpack_from('<4sI', data, position)
        start, stop = position + 8, position + 8 + size
        if stop > len(data):
            raise ValueError('WAV chunk is incomplete')
        if name == b'fmt ':
            if fmt is not None or size < 16:
                raise ValueError('Invalid or duplicate WAV format')
            fmt = struct.unpack_from('<HHIIHH', data, start)
            if fmt[0] == 0xfffe and size >= 40:
                fmt = (struct.unpack_from('<H', data, start + 24)[0], *fmt[1:])
        elif name == b'data':
            if audio is not None:
                raise ValueError('Duplicate WAV data')
            audio = data[start:stop]
        position = stop + (size & 1)
    if position != len(data) or fmt is None or audio is None:
        raise ValueError('Incomplete WAV structure')
    encoding, channels, rate, byte_rate, alignment, bits = fmt
    if channels != 1 or not 8000 <= rate <= 96000 or alignment != channels * bits // 8 or byte_rate != rate * alignment:
        raise ValueError('Unexpected WAV format')
    formats = {(1, 16): ('h', 32768), (3, 32): ('f', 1), (3, 64): ('d', 1)}
    if (encoding, bits) not in formats or len(audio) % alignment:
        raise ValueError('Unsupported or truncated WAV samples')
    kind, scale = formats[(encoding, bits)]
    values = array.array(kind)
    values.frombytes(audio)
    if sys.byteorder != 'little':
        values.byteswap()
    duration = len(values) / rate
    if not .25 <= duration <= 120 or not all(math.isfinite(value) for value in values):
        raise ValueError('Generated audio is empty, too long or non-finite')
    peak = max(abs(value) for value in values) / scale
    rms = math.sqrt(sum((value / scale) ** 2 for value in values) / len(values))
    if not math.isfinite(peak) or not math.isfinite(rms) or peak <= .001 or rms <= .00001:
        raise ValueError('Generated audio is silent or has invalid amplitude')
    return dict(sha256=integrity.sha256(path), bytes=len(data), sampleRate=rate, channels=channels,
                durationSeconds=duration, peak=peak, rms=rms, finite=True, sampleCount=len(values))


def inventory(root: Path) -> dict:
    records = {}
    if not root.is_dir() or root.is_symlink():
        raise ValueError(f'Expected a real installed directory: {root}')
    for path in sorted(root.rglob('*')):
        if path.is_symlink():
            raise ValueError(f'Unexpected symlink inside speech installation: {path}')
        if path.is_file():
            records[path.relative_to(root).as_posix()] = dict(
                bytes=path.stat().st_size, sha256=integrity.sha256(path),
                executable=bool(path.stat().st_mode & 0o111) if os.name != 'nt' else None)
    if not records:
        raise ValueError('Installed speech directory is empty')
    return records


def installation_snapshot(resources: Path, executable: Path) -> dict:
    result = {'resources': inventory(resources)}
    if resources != executable:
        result['executables'] = inventory(executable)
    return result


def compile_test(target: str, output: Path, env: dict) -> Path:
    log = output / 'compile.log'
    integrity.run(['cargo', 'test', '--manifest-path', ROOT / 'src-tauri/Cargo.toml',
                   '--target', target, '--no-default-features', '--locked', '--lib', '--no-run',
                   '--message-format=json'], log, env=env, cwd=ROOT, timeout=1800)
    executables = set()
    for line in log.read_text(encoding='utf-8', errors='replace').splitlines():
        try:
            item = json.loads(line)
        except ValueError:
            continue
        if item.get('reason') == 'compiler-artifact' and item.get('profile', {}).get('test') and item.get('executable'):
            executables.add(item['executable'])
    if len(executables) != 1:
        raise ValueError(f'Expected exactly one compiled library test binary, found {len(executables)}')
    executable = Path(executables.pop()).resolve(strict=True)
    integrity.run([executable, TEST, '--exact', '--list'], output / 'test-discovery.log', env=env, cwd=ROOT, timeout=60)
    if f'{TEST}: test' not in (output / 'test-discovery.log').read_text(encoding='utf-8'):
        raise ValueError('The compiled binary does not contain the production synthesis test')
    integrity.run([executable, 'speech::tests::', '--nocapture', '--test-threads=1'],
                  output / 'speech-process-regressions.log', env=env, cwd=ROOT, timeout=180)
    return executable


def stage_fields(line: str) -> dict:
    return dict(value.split('=', 1) for value in line.split(',') if '=' in value)


def collect_voice(directory: Path, voice: str, availability: dict) -> dict:
    job = directory / voice
    proof = json.loads((job / 'result.json').read_text(encoding='utf-8'))
    if proof.get('voiceId') != voice or not proof.get('success') or not proof.get('audioValidated'):
        raise ValueError(f'Production synthesis did not pass: {voice}')
    if proof.get('text') != TEXT or proof.get('productionPath') != 'SpeechRuntime::command + generate_wave':
        raise ValueError(f'Voice did not use the required text and production command: {voice}')
    audio = inspect_audio(job / 'speech.wav')
    if audio['sampleRate'] != (16000 if voice == 'matcha_zh_en_female' else 24000):
        raise ValueError('Generated audio sample rate differs from the voice model contract')
    if (audio['sha256'], audio['bytes'], audio['sampleRate']) != (proof['audioSha256'], proof['audioBytes'], proof['sampleRate']):
        raise ValueError(f'Production evidence and independently decoded audio differ: {voice}')
    log = (job / 'generation.log').read_text(encoding='utf-8')
    events = [line for line in log.splitlines() if line.startswith('stage=')]
    device_events = [stage_fields(line) for line in events if line.startswith('stage=device,')]
    backend = proof.get('backend')
    if backend not in ('cpu', 'mps', 'cuda', 'coreml') or not device_events or device_events[-1].get('device') != backend:
        raise ValueError(f'Voice has no consistent final execution backend: {voice}')
    if not events or stage_fields(events[-1]).get('stage') != 'complete':
        raise ValueError(f'Voice did not report normal completion: {voice}')
    if backend in ('mps', 'cuda') and not availability['python'][f'{backend}Available']:
        raise ValueError('A GPU backend cannot be reported when the released runtime probe says unavailable')
    if backend == 'coreml' and voice.startswith(('f5_', 'qwen3_')):
        raise ValueError('A Python model cannot report the native provider')
    return dict(voiceId=voice, status='passed', text=TEXT,
                audio=dict(audio, path=f'{voice}/speech.wav'), backend=backend,
                requestedDevice='auto', gpuInferenceVerified=(None if backend == 'coreml' else backend in ('mps', 'cuda')),
                backendNote=('CoreML execution provider completed; individual operator placement is not measured.'
                             if backend == 'coreml' else 'Actual final backend reported by production synthesis.'),
                events=events, partial=[line for line in events if 'partial=' in line],
                fallback=[line for line in events if line.startswith('stage=fallback,')],
                elapsedSeconds=proof['elapsedSeconds'], productionPath=proof['productionPath'],
                completionVerified=True,
                eosVerified=voice.startswith('qwen3_'),
                eosVerification=('The locked runtime rejects generation without the final codec EOS token.'
                                 if voice.startswith('qwen3_') else 'Not an autoregressive codec model.'))


def prepare_model(model: dict, store: Path) -> Path:
    root = store / f'{model["id"]}-v{model["version"]}'
    root.mkdir(parents=True)
    for item in model['files']:
        path = root / integrity.relative(item['path'])
        path.parent.mkdir(parents=True, exist_ok=True)
        if item.get('embedded'):
            source = ROOT / 'scripts/optional-speech-assets' / integrity.relative(item['embedded'])
            if not integrity.checked_file(source, item['size'], item['sha256']):
                raise ValueError(f'Application-owned model asset does not match the catalog: {item["path"]}')
            shutil.copyfile(source, path)
        else:
            integrity.download(item, path)
    return root


def verify_model(model: dict, root: Path) -> dict:
    expected = {item['path'] for item in model['files']}
    actual = {path.relative_to(root).as_posix() for path in root.rglob('*') if path.is_file()}
    if actual != expected or any(path.is_symlink() for path in root.rglob('*')):
        raise ValueError('Model file list changed during synthesis')
    for item in model['files']:
        if not integrity.checked_file(root / integrity.relative(item['path']), item['size'], item['sha256']):
            raise ValueError('Locked model file changed during synthesis')
    return dict(modelId=model['id'], files=len(expected), unchanged=True)


def probe_python(executable: Path, output: Path, env: dict) -> dict:
    code = ('import json,platform,torch; m=getattr(torch.backends,"mps",None); '
            'print(json.dumps(dict(torchVersion=torch.__version__,pythonVersion=platform.python_version(),'
            'mpsBuilt=bool(m and m.is_built()),mpsAvailable=bool(m and m.is_available()),'
            'cudaAvailable=bool(torch.cuda.is_available()),cudaDeviceCount=torch.cuda.device_count())))')
    log = output / 'python-hardware-probe.log'
    integrity.run([executable, '-I', '-B', '-c', code], log, env=env, cwd=output, timeout=180)
    values = [json.loads(line) for line in log.read_text(encoding='utf-8').splitlines() if line.startswith('{')]
    if len(values) != 1 or not all(isinstance(values[0].get(key), bool) for key in ('mpsAvailable', 'cudaAvailable')):
        raise ValueError('The published runtime did not return a valid hardware probe')
    return values[0]


def main() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='replace')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--platform', required=True, choices=PLATFORMS)
    parser.add_argument('--target', required=True)
    parser.add_argument('--speech-directory', type=Path, required=True)
    parser.add_argument('--speech-executable-directory', type=Path, required=True)
    parser.add_argument('--work', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if (platform.system(), platform.machine().lower(), args.target) != PLATFORMS[args.platform]:
        raise ValueError('Voice validation must execute on the actual target OS and architecture')
    resources = args.speech_directory.resolve(strict=True)
    helpers = args.speech_executable_directory.resolve(strict=True)
    work = args.work.resolve() / '中文配音 空格'
    output = args.output.resolve()
    for directory in (work, output):
        if any(directory == installed or directory.is_relative_to(installed) for installed in (resources, helpers)):
            raise ValueError('Validation must never write inside the installed application')
    if output.exists() and any(output.iterdir()):
        raise ValueError('Evidence output must be empty; do not overwrite previous results')
    output.mkdir(parents=True, exist_ok=True)
    work.mkdir(parents=True, exist_ok=True)
    store = work / '已下载 音色'
    store.mkdir()
    evidence = output / '中文配音 空格'
    env = integrity.clean_environment()
    for key in tuple(env):
        if key.startswith('OPEN_MEDIA_TEST_') or key in ('OPEN_MEDIA_SPEECH_ROOT', 'OPEN_MEDIA_SPEECH_EXECUTABLE_ROOT'):
            env.pop(key)
    cache = work / '用户缓存'
    cache.mkdir()
    env.update(HF_HOME=str(cache / 'hf'), HF_HUB_CACHE=str(cache / 'hf/hub'), TORCH_HOME=str(cache / 'torch'),
               NUMBA_CACHE_DIR=str(cache / 'numba'), MPLCONFIGDIR=str(cache / 'plot'), XDG_CACHE_HOME=str(cache),
               HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1',
               OPEN_MEDIA_SPEECH_ROOT=str(resources), OPEN_MEDIA_SPEECH_EXECUTABLE_ROOT=str(helpers),
               OPEN_MEDIA_TEST_EVIDENCE_DIR=str(evidence), OPEN_MEDIA_TEST_TEXT=TEXT)
    catalog = json.loads((ROOT / 'src-tauri/resources/speech-models.json').read_text(encoding='utf-8'))
    runtime = next(item for item in catalog['runtimes'] if item['id'] == 'python-cpu-v1')
    spec = runtime['platforms'][args.platform]
    metadata = dict(spec, platform=args.platform)
    runtime_root = store / f'runtime-{runtime["id"]}-v{runtime["version"]}-{args.platform}'
    archive = work / 'released-python-runtime.zip'
    before = installation_snapshot(resources, helpers)
    integrity.write_json(output / 'installation-before.json', before)
    summary = dict(schema=1, platform=args.platform,
                   sourceCommit=subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
                   status='running', voices=[], availability={'native': {'operatorPlacementMeasured': False}},
                   models=[], text=TEXT, runtimeIntegrity={'unchanged': False}, installationIntegrity={'unchanged': False})
    integrity.write_json(output / 'summary.json', summary)
    began = time.monotonic()
    try:
        binary = compile_test(args.target, output, env)
        integrity.download(spec, archive)
        integrity.verify_archive(archive, runtime_root, metadata)
        summary['runtimeIntegrity']['before'] = integrity.verify_tree(runtime_root, metadata)
        summary['runtimeIntegrity'].update(archiveSha256=spec['sha256'], archiveBytes=spec['size'],
                                           runtimeId=runtime['id'], releasedVersion=runtime['version'])
        integrity.write_json(output / 'runtime-metadata.json', metadata)
        summary['availability']['python'] = probe_python(runtime_root / integrity.relative(spec['executable']), output, env)
        summary['groupedAttentionRegression'] = []
        attention_devices = ['cpu']
        if summary['availability']['python']['mpsAvailable']:
            attention_devices.append('mps')
        for device in attention_devices:
            proof_path = output / f'grouped-attention-{device}.json'
            integrity.run([runtime_root / integrity.relative(spec['executable']), '-I', '-B',
                           ROOT / 'scripts/test-speech-qwen-attention.py', '--device', device,
                           '--output', proof_path], output / f'grouped-attention-{device}.log',
                          env=env, cwd=work, timeout=180)
            proof = json.loads(proof_path.read_text(encoding='utf-8'))
            if proof.get('status') != 'passed' or proof.get('device') != device:
                raise ValueError('The grouped-attention regression did not pass on the selected device')
            summary['groupedAttentionRegression'].append(proof)
        integrity.write_json(output / 'summary.json', summary)
        def synthesize(voice: str, model_root: Path | None = None) -> None:
            print(f'Verifying installed voice {voice}', flush=True)
            voice_env = dict(env, OPEN_MEDIA_TEST_VOICE_ID=voice)
            if model_root is not None:
                voice_env['OPEN_MEDIA_TEST_MODEL_ROOT'] = str(model_root)
            integrity.run([binary, TEST, '--exact', '--ignored', '--nocapture', '--test-threads=1'],
                          output / f'{voice}.test.log', env=voice_env, cwd=work, timeout=3600)
            result = collect_voice(evidence, voice, summary['availability'])
            result['audio']['path'] = (evidence / voice / 'speech.wav').relative_to(output).as_posix()
            summary['voices'].append(result)
            integrity.write_json(output / 'summary.json', summary)
        synthesize(VOICES[0])
        for model in catalog['models']:
            model_root = prepare_model(model, store)
            for voice in model['voices']:
                synthesize(voice['id'], model_root)
            summary['models'].append(verify_model(model, model_root))
            shutil.rmtree(model_root)
        if [item['voiceId'] for item in summary['voices']] != list(VOICES):
            raise ValueError('All seven voices must be verified exactly once')
        summary['gpuInference'] = dict(
            verifiedVoices=[item['voiceId'] for item in summary['voices'] if item['gpuInferenceVerified'] is True],
            nativeOperatorPlacementMeasured=False,
            note='CPU fallback success does not establish GPU execution or performance. CoreML operator placement is not measured.')
        summary['status'] = 'passed'
    except BaseException as error:
        summary.update(status='failed', error=f'{type(error).__name__}: {error}')
        raise
    finally:
        try:
            after = installation_snapshot(resources, helpers)
            integrity.write_json(output / 'installation-after.json', after)
            if before != after:
                raise ValueError('Installed application resources or executable bytes changed during validation')
            summary['installationIntegrity'] = dict(unchanged=True,
                before='installation-before.json', after='installation-after.json',
                snapshotSha256=integrity.sha256(output / 'installation-before.json'))
            if runtime_root.exists():
                summary['runtimeIntegrity']['after'] = integrity.verify_tree(runtime_root, metadata)
                if not integrity.checked_file(archive, spec['size'], spec['sha256']):
                    raise ValueError('Released runtime archive changed during verification')
                summary['runtimeIntegrity']['unchanged'] = True
        except BaseException as error:
            summary.update(status='failed', integrityError=f'{type(error).__name__}: {error}')
            raise
        finally:
            summary['elapsedSeconds'] = time.monotonic() - began
            integrity.write_json(output / 'summary.json', summary)


if __name__ == '__main__':
    main()
