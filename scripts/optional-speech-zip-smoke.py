#!/usr/bin/env python3
"""Run verified native voice synthesis on the host, without building the app."""
import argparse
import array
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import wave

ROOT = Path(__file__).resolve().parents[1]
SMOKE_SAMPLES = (
    dict(id='01', text='欢迎使用 Open Media。录制画面，整理素材，添加字幕，让创作更轻松。',
         normalized_text='欢迎使用 Open Media。录制画面，整理素材，添加字幕，让创作更轻松。'),
    dict(id='09', text='这个项目包含12个片段，视频时长为3.5分钟，导出进度已经达到80%。',
         normalized_text='这个项目包含十二个片段，视频时长为三点五分钟，导出进度已经达到百分之八十。'),
)


def digest(path):
    sha = hashlib.sha256()
    with path.open('rb') as stream:
        while chunk := stream.read(1024 * 1024):
            sha.update(chunk)
    return sha.hexdigest()


def safe_path(base, relative):
    path = PurePosixPath(relative)
    if not relative or '\\' in relative or path.is_absolute() or any(p in ('', '.', '..') for p in relative.split('/')) or ':' in relative:
        raise ValueError(f'Unsafe model path: {relative}')
    result = base.joinpath(*path.parts)
    result.resolve().relative_to(base.resolve())
    return result


def valid_file(path, item):
    return path.is_file() and path.stat().st_size == item['size'] and digest(path) == item['sha256']


def download(item, destination, assets, reuse):
    """Use only an exact reviewed byte match, including all local CI fallbacks."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    if valid_file(destination, item):
        return 'verified-cache'
    url = urllib.parse.urlparse(item['url'])
    if url.scheme != 'https' or not url.netloc:
        raise ValueError('Model downloads must use HTTPS')
    candidates = [safe_path(base, item['path']) for base in reuse]
    if url.netloc == 'github.com' and url.path.startswith('/ecojust/open-media/releases/download/speech-runtime-v1/'):
        candidates.append(assets / Path(url.path).name)
    for candidate in candidates:
        if valid_file(candidate, item):
            shutil.copyfile(candidate, destination)
            return 'verified-local-source'
    temporary = destination.with_name(destination.name + '.partial')
    try:
        for attempt in range(3):
            try:
                request = urllib.request.Request(item['url'], headers={'User-Agent': 'Open-Media-Speech-Smoke/1'})
                with urllib.request.urlopen(request, timeout=90) as response, temporary.open('wb') as stream:
                    received = 0
                    while chunk := response.read(1024 * 1024):
                        received += len(chunk)
                        if received > item['size']:
                            raise ValueError(f'Model download exceeds declared size: {item["path"]}')
                        stream.write(chunk)
                if not valid_file(temporary, item):
                    raise ValueError(f'Model integrity verification failed: {item["path"]}')
                temporary.replace(destination)
                return 'verified-download'
            except Exception:
                if attempt == 2:
                    raise
                time.sleep(2)
    finally:
        temporary.unlink(missing_ok=True)


def run(command, log, timeout=1800):
    with log.open('w', encoding='utf-8') as stream:
        result = subprocess.run([str(arg) for arg in command], stdout=stream, stderr=subprocess.STDOUT,
                                cwd=ROOT, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f'Command failed ({result.returncode}): {command[0]}; see {log}')


def native_device_state(log):
    backend, writing = None, False
    for line in log.splitlines():
        if line.startswith(('stage=device,', 'stage=fallback,')):
            selected = next((field[len('device='):] for field in line.split(',') if field.startswith('device=')), None)
            backend = selected if selected in ('cpu', 'coreml', 'mps', 'cuda') else None
            if line.startswith('stage=device,'):
                writing = False
        elif re.match(r'^stage=(writing|complete)(,|$)', line):
            writing = True
    return dict(backend=backend, writing=writing)


def should_retry_native_cpu(result, retried=False):
    state = native_device_state(result.stdout or '')
    # Python uses negative POSIX signal numbers for terminated subprocesses.
    # Never turn cancellation/termination into a new synthesis job.
    return (not retried and result.returncode != 0 and state['backend'] == 'coreml'
            and not state['writing'] and result.returncode not in (-1, -2, -9, -15))


def run_native_speech(command, log, output, timeout=1800):
    started = time.monotonic()
    attempts = []
    full_log = ''

    def execute(values, remaining):
        nonlocal full_log
        try:
            result = subprocess.run([str(arg) for arg in values], capture_output=True,
                                    encoding='utf-8', errors='replace', cwd=ROOT, timeout=remaining)
        except subprocess.TimeoutExpired as error:
            # Keep the failed attempt's evidence, and propagate without retry.
            def decoded(value):
                return value.decode('utf-8', errors='replace') if isinstance(value, bytes) else value or ''
            full_log += decoded(error.stdout) + decoded(error.stderr)
            log.write_text(full_log + '\nNative speech timed out; no CPU retry.\n', encoding='utf-8')
            output.unlink(missing_ok=True)
            raise
        full_log += (result.stdout or '') + (result.stderr or '')
        log.write_text(full_log, encoding='utf-8')
        attempts.append(dict(**native_device_state(result.stdout or ''), returnCode=result.returncode,
                             error=(result.stderr or '').strip()[-4000:]))
        return result

    output.unlink(missing_ok=True)
    result = execute(command, timeout)
    fallback_from = None
    remaining = timeout - (time.monotonic() - started)
    if remaining > 0 and should_retry_native_cpu(result):
        fallback_from = 'coreml'
        print(f'CoreML attempt failed ({result.returncode}); retrying once on CPU. Original output: {log}', flush=True)
        full_log += '\nstage=fallback,from=coreml,device=cpu,reason=native_process_failed\n'
        output.unlink(missing_ok=True)
        result = execute([value for value in command if not str(value).startswith('--provider=')]
                         + ['--provider=cpu'], remaining)
    if result.returncode:
        output.unlink(missing_ok=True)
        raise RuntimeError(f'Native speech failed ({result.returncode}): {command[0]}; see {log}')
    backend = native_device_state(result.stdout or '')['backend']
    if not backend or (fallback_from and backend != 'cpu'):
        raise RuntimeError('Native speech did not report the expected execution device')
    return dict(backend=backend, fallbackFrom=fallback_from, attempts=attempts)


def inspect_audio(path):
    with wave.open(str(path), 'rb') as stream:
        if (stream.getnchannels(), stream.getsampwidth(), stream.getframerate()) != (1, 2, 24000):
            raise ValueError('Expected 24 kHz mono PCM16 output')
        samples = array.array('h', stream.readframes(stream.getnframes()))
    if sys.byteorder != 'little':
        samples.byteswap()
    if len(samples) < 2400:
        raise ValueError('Generated voice is empty or too short')
    rms = math.sqrt(sum((sample / 32768) ** 2 for sample in samples) / len(samples))
    if not math.isfinite(rms) or rms <= 0.0001:
        raise ValueError('Generated voice is silent or invalid')
    return dict(sampleRate=24000, channels=1, seconds=len(samples) / 24000, rms=rms,
                peak=max(abs(sample) for sample in samples) / 32768,
                clippedSamples=sum(abs(sample) >= 32767 for sample in samples),
                bytes=path.stat().st_size, sha256=digest(path))


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='replace')
    parser = argparse.ArgumentParser()
    parser.add_argument('--catalog', type=Path, default=ROOT / 'src-tauri/resources/speech-models.json')
    parser.add_argument('--speech-directory', type=Path, default=ROOT / 'src-tauri/resources/speech')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--assets', type=Path, default=ROOT / 'scripts/optional-speech-assets')
    parser.add_argument('--reuse-directory', action='append', type=Path, default=[])
    parser.add_argument('--prepare', action='store_true', help='Compile and prepare only the native voice runtime')
    parser.add_argument('--rustc', default='rustc')
    args = parser.parse_args()
    args.output = args.output.resolve()
    args.speech_directory = args.speech_directory.resolve()
    args.output.mkdir(parents=True, exist_ok=True)
    catalog = json.loads(args.catalog.read_text(encoding='utf-8'))
    model = next(item for item in catalog['models'] if item['id'] == 'zipvoice-distill-fp32')
    if model['model']['kind'] != 'zipvoice':
        raise ValueError('The requested native model is not configured correctly')
    if args.prepare:
        run(['node', ROOT / 'scripts/speech-runtime.mjs', 'prepare', '--directory', args.speech_directory],
            args.output / 'prepare.log')
    installed = json.loads((args.speech_directory / 'runtime.json').read_text(encoding='utf-8'))
    if installed['runnerSourceSha256'] != digest(ROOT / 'scripts/speech-runtime-runner.c'):
        raise ValueError('Native helper is stale; run with --prepare')
    for item in installed['files']:
        if digest(safe_path(args.speech_directory, item['path'])) != item['sha256']:
            raise ValueError(f'Prepared native resource failed integrity verification: {item["path"]}')
    runtime_manifest = json.loads((args.speech_directory / 'manifest.json').read_text(encoding='utf-8'))
    executable = safe_path(args.speech_directory, runtime_manifest['executable'])
    executable_record = next(item for item in installed['files'] if item['path'] == runtime_manifest['executable'])
    if digest(executable) != executable_record['sha256']:
        raise ValueError('Prepared native executable failed integrity verification')

    # The complete model, reference, text and output paths intentionally contain
    # both non-ASCII characters and spaces, including on Windows.
    work = args.output / '中文配音 空格'
    model_directory = work / '模型 文件'
    model_directory.mkdir(parents=True, exist_ok=True)
    downloads = []
    for item in model['files']:
        destination = safe_path(model_directory, item['path'])
        source = download(item, destination, args.assets, args.reuse_directory)
        downloads.append(dict(path=item['path'], source=source, size=item['size'], sha256=digest(destination)))
        print(f'Verified {item["path"]}', flush=True)

    suffix = '.exe' if os.name == 'nt' else ''
    rustc = [args.rustc, '--edition=2021']
    if os.name == 'nt':
        # Git Bash also places a POSIX utility named link.exe on PATH. Resolve
        # the real compiler's sibling linker instead of letting rustc pick it.
        compiler = shutil.which('cl.exe')
        linker = Path(compiler).with_name('link.exe') if compiler else None
        if not linker or not linker.is_file():
            raise RuntimeError('The native speech smoke requires the MSVC developer command environment')
        rustc += ['-C', f'linker={linker}']
    normalizer = work / f'number-normalizer{suffix}'
    run([*rustc, ROOT / 'scripts/speech-chinese-smoke.rs', '-o', normalizer],
        args.output / 'normalizer-build.log', 300)
    normalizer_tests = work / f'number-normalizer-tests{suffix}'
    run([*rustc, '--test', ROOT / 'src-tauri/src/speech_chinese.rs', '-o', normalizer_tests],
        args.output / 'normalizer-tests-build.log', 300)
    run([normalizer_tests], args.output / 'normalizer-tests.log', 120)

    def resource(relative):
        if relative.startswith('@bundled/'):
            return safe_path(args.speech_directory, relative[len('@bundled/'):])
        return safe_path(model_directory, relative)

    config = model['model']
    command = [executable, '--sample-rate=24000', '--num-steps=8', '--speed=1', '--sid=0', '--debug=true']
    for field, flag in [('encoder', 'encoder'), ('decoder', 'decoder'), ('vocoder', 'vocoder'),
                        ('tokens', 'tokens'), ('dataDir', 'data-dir')]:
        command.append(f'--zipvoice-{flag}={resource(config[field])}')
    command += ['--zipvoice-lexicon=' + ','.join(str(resource(path)) for path in config['lexicons']),
                f'--reference-audio={resource(config["referenceAudio"])}',
                f'--reference-text-file={resource(config["referenceText"])}']
    proof = dict(schema=1, modelId=model['id'], platform=platform.platform(), machine=platform.machine(),
                 python=platform.python_version(), catalogSha256=digest(args.catalog),
                 runnerSourceSha256=installed['runnerSourceSha256'], runnerSha256=digest(executable),
                 preparedManifestSha256=digest(args.speech_directory / 'runtime.json'),
                 precision='FP32', steps=8, threads=1, pathCoverage='non-ASCII and spaces',
                 files=downloads, samples=[])
    for sample in SMOKE_SAMPLES:
        sample_id = sample['id']
        original = work / f'{sample_id} 原文.txt'
        normalized = work / f'{sample_id} 规范化.txt'
        audio = work / f'{sample_id} 音频.wav'
        original.write_text(sample['text'], encoding='utf-8')
        run([normalizer, original, normalized], args.output / f'{sample_id}-normalize.log', 30)
        actual_text = normalized.read_text(encoding='utf-8')
        if actual_text != sample['normalized_text']:
            raise ValueError(f'Native normalization differs from the fixed smoke expectation: {sample_id}')
        started = time.monotonic()
        execution = run_native_speech([*command, f'--text-file={normalized}', f'--output-filename={audio}'],
                                     args.output / f'{sample_id}.log', audio)
        result = dict(id=sample_id, text=sample['text'], normalizedText=actual_text,
                      generationSeconds=time.monotonic() - started, audio=str(audio.relative_to(args.output)),
                      execution=execution, **inspect_audio(audio))
        proof['samples'].append(result)
        note = (' (CoreML failed; CPU fallback succeeded, GPU inference was not verified)' if execution['fallbackFrom']
                else ' (CoreML may execute unsupported operators on CPU)' if execution['backend'] == 'coreml' else '')
        print(f'Generated {sample_id}: {result["seconds"]:.3f} seconds of valid audio; backend: {execution["backend"]}{note}', flush=True)
    proof['status'] = 'passed'
    (args.output / 'proof.json').write_text(json.dumps(proof, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
