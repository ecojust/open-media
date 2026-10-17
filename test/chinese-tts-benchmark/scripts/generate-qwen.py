#!/usr/bin/env python3
"""Generate reproducible Chinese listening samples using a local CPU model."""
import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import resource
import subprocess
import sys
import time
import urllib.request

REPO = 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice'
REVISION = '0c0e3051f131929182e2c023b9537f8b1c68adfe'
SOURCE_REVISION = '022e286b98fbec7e1e916cb940cdf532cd9f488e'
MODEL_FILES = [
    ('config.json', 4908, '95d74b20b7485f5dfa09d05988d6c606ec226811', False),
    ('generation_config.json', 245, '1872b16d4535564abf2db5d6debe6cddd82b7f2e', False),
    ('merges.txt', 1671839, '20024bfe7c83998e9aeaf98a0cd6a2ce6306c2f0', False),
    ('model.safetensors', 3833402552, '38b1d5971bdbd982b561cccec982669a53b0537c3cf5e9bd4778ed07bb2f5137', True),
    ('preprocessor_config.json', 127, '0525dd953bb9241912f7147666f0d535165d5d4f', False),
    ('speech_tokenizer/config.json', 2336, '06cc8dc4c5ec8a1929086b71b98c313020d9268b', False),
    ('speech_tokenizer/configuration.json', 76, 'ab58e2eaf53cd14a1a2a7527d9261ceea93a24cd', False),
    ('speech_tokenizer/model.safetensors', 682293092, '836b7b357f5ea43e889936a3709af68dfe3751881acefe4ecf0dbd30ba571258', True),
    ('speech_tokenizer/preprocessor_config.json', 234, 'ba40914f4f49ab98a8ca545d4892ef7291a39592', False),
    ('tokenizer_config.json', 7344, '6ff9fd60cc623bb54bbd603cbd418c97a11528d7', False),
    ('vocab.json', 2776833, '4783fe10ac3adce15ac8f358ef5462739852c569', False),
]


def notice(message):
    # Escape workflow command characters without changing model inputs.
    escaped = str(message).replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A')
    print(f'::notice::{escaped}', flush=True)


def cpu_flags():
    path = Path('/proc/cpuinfo')
    if not path.is_file():
        return []
    for line in path.read_text().splitlines():
        if line.startswith('flags') or line.startswith('Features'):
            return line.split(':', 1)[1].strip().split()
    return []


def atomic_json(path, data):
    temp = path.with_suffix(path.suffix + '.tmp')
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    temp.replace(path)


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        while chunk := source.read(4 * 1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def prepare_model(model_dir):
    files = []
    for name, expected_bytes, expected_hash, lfs in MODEL_FILES:
        dest = model_dir / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        url = f'https://huggingface.co/{REPO}/resolve/{REVISION}/{name}?download=true'
        if not dest.is_file() or dest.stat().st_size != expected_bytes:
            for attempt in range(3):
                temp = dest.with_suffix(dest.suffix + '.part')
                try:
                    with urllib.request.urlopen(url, timeout=120) as response, temp.open('wb') as output:
                        while chunk := response.read(4 * 1024 * 1024):
                            output.write(chunk)
                    if temp.stat().st_size != expected_bytes:
                        raise ValueError(f'Download size mismatch: {name}')
                    temp.replace(dest)
                    break
                except Exception:
                    if attempt == 2:
                        raise
                    time.sleep(2)
        actual_sha256 = sha256(dest)
        if lfs:
            actual_source_hash = actual_sha256
        else:
            contents = dest.read_bytes()
            actual_source_hash = hashlib.sha1(f'blob {len(contents)}\0'.encode() + contents).hexdigest()
        if actual_source_hash != expected_hash:
            raise ValueError(f'Download integrity mismatch: {name}')
        files.append(dict(path=name, bytes=expected_bytes, sha256=actual_sha256,
                          source=f'https://huggingface.co/{REPO}/resolve/{REVISION}/{name}'))
        print(f'Verified {name}: {expected_bytes:,} bytes', flush=True)
    return files


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--corpus', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--model-dir', type=Path, required=True)
    parser.add_argument('--threads', type=int, default=4)
    parser.add_argument('--limit', type=int, default=10)
    parser.add_argument('--start', type=int, default=1, help='One-based first corpus sample')
    parser.add_argument('--dtype', choices=('auto', 'bfloat16', 'float32'), default='auto')
    parser.add_argument('--download-only', action='store_true')
    args = parser.parse_args()
    output = args.output
    if args.start < 1 or args.limit < 1 or args.start + args.limit - 1 > 10:
        raise ValueError('Requested corpus range must be within 01..10')
    flags = cpu_flags()
    native_bf16 = bool({'avx512_bf16', 'amx_bf16'} & set(flags))
    dtype = ('bfloat16' if native_bf16 else 'float32') if args.dtype == 'auto' else args.dtype
    notice(f'Preparing samples {args.start:02d}..{args.start + args.limit - 1:02d}; CPU BF16 instructions={native_bf16}; dtype={dtype}')
    for directory in ('wav', 'audio', 'licenses'):
        (output / directory).mkdir(parents=True, exist_ok=True)
    notice('Downloading and verifying 11 required model files (4,520,159,586 bytes)')
    files = prepare_model(args.model_dir)
    notice('Model download and integrity verification complete: 4,520,159,586 bytes')
    for url, name in [
        (f'https://huggingface.co/{REPO}/raw/{REVISION}/README.md', 'MODEL_CARD.md'),
        (f'https://raw.githubusercontent.com/QwenLM/Qwen3-TTS/{SOURCE_REVISION}/LICENSE', 'LICENSE'),
    ]:
        (output / 'licenses' / name).write_bytes(urllib.request.urlopen(url, timeout=60).read())
    manifest = dict(
        id='qwen3-tts-1.7b-serena', name='Qwen3-TTS 1.7B · Serena',
        model_family='Qwen3-TTS-12Hz-1.7B-CustomVoice', voice='Serena', language='zh-CN',
        model_download_bytes=sum(item['bytes'] for item in files),
        source=dict(repository=f'https://huggingface.co/{REPO}', revision=REVISION,
                    implementation='qwen-tts==0.1.1', files=files),
        license=dict(spdx='Apache-2.0', path='licenses/LICENSE', model_card='licenses/MODEL_CARD.md'),
        settings=dict(device='cpu', dtype=dtype, dtype_selection=args.dtype, attention='sdpa', threads=args.threads,
                      language='Chinese', speaker='Serena',
                      instruct='用自然流畅的标准普通话朗读，语气温和，语速适中。',
                      non_streaming_mode=True, do_sample=True, temperature=0.9, top_p=1.0,
                      top_k=50, repetition_penalty=1.05, subtalker_dosample=True,
                      subtalker_temperature=0.9, subtalker_top_p=1.0, subtalker_top_k=50,
                      max_new_tokens=2048, seed_base=20261017,
                      text_normalization='none; original corpus text is passed unchanged',
                      postprocessing='none; original PCM WAV and MP3 encoding only'),
        environment=dict(python=platform.python_version(), platform=platform.platform(),
                         processor=platform.processor(), logical_cpu_count=os.cpu_count(),
                         cpu_flags=flags, native_bf16=native_bf16),
        corpus_range=dict(start=args.start, count=args.limit),
        samples=[], peak_rss_bytes=None,
    )
    atomic_json(output / 'manifest.json', manifest)
    if args.download_only:
        return
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'
    os.environ['OMP_NUM_THREADS'] = str(args.threads)
    os.environ['MKL_NUM_THREADS'] = str(args.threads)
    os.environ['TOKENIZERS_PARALLELISM'] = 'false'
    import numpy as np
    import soundfile as sf
    import torch
    from qwen_tts import Qwen3TTSModel
    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(1)
    manifest['environment']['packages'] = {
        name: importlib.metadata.version(name)
        for name in ('torch', 'torchaudio', 'qwen-tts', 'transformers', 'accelerate', 'numpy', 'soundfile')
    }
    started = time.perf_counter()
    model = Qwen3TTSModel.from_pretrained(str(args.model_dir.resolve()), device_map='cpu',
                                        dtype=getattr(torch, dtype), attn_implementation='sdpa', local_files_only=True,
                                        low_cpu_mem_usage=True)
    manifest['model_load_seconds'] = time.perf_counter() - started
    notice(f'Model loaded in {manifest["model_load_seconds"]:.2f}s; dtype={dtype}; peak RSS={resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024:,} bytes; speakers={model.get_supported_speakers()}')
    corpus = json.loads(args.corpus.read_text())
    if isinstance(corpus, dict):
        corpus = corpus.get('samples', corpus.get('corpus', corpus.get('items', [])))
    if not corpus or len(corpus) < args.start + args.limit - 1:
        raise ValueError('Corpus does not contain the requested sample count')
    for index in range(args.start - 1, args.start - 1 + args.limit):
        item = corpus[index]
        identifier = str(item['id']).zfill(2)
        text = item.get('texts', {}).get('zh', item.get('text', item.get('zh')))
        if not text:
            raise ValueError(f'Missing Chinese corpus text for {identifier}')
        if index == 0 and text != '这是一款全程由AI接管并生成的软件':
            raise ValueError('The original first sentence must be preserved exactly')
        settings = manifest['settings']
        seed = settings['seed_base'] + index
        torch.manual_seed(seed)
        np.random.seed(seed)
        notice(f'Generating sample {identifier}; dtype={dtype}; seed={seed}; text={text}')
        generation_started = time.perf_counter()
        with torch.inference_mode():
            waves, sample_rate = model.generate_custom_voice(
                text=text, language=settings['language'], speaker=settings['speaker'],
                instruct=settings['instruct'], non_streaming_mode=settings['non_streaming_mode'],
                **{key: settings[key] for key in ('do_sample', 'temperature', 'top_p', 'top_k',
                    'repetition_penalty', 'subtalker_dosample', 'subtalker_temperature',
                    'subtalker_top_p', 'subtalker_top_k', 'max_new_tokens')},
            )
        generation_seconds = time.perf_counter() - generation_started
        wave = np.asarray(waves[0], dtype=np.float32)
        if not len(wave) or not np.isfinite(wave).all():
            raise ValueError(f'Invalid generated samples: {identifier}')
        peak = float(np.max(np.abs(wave)))
        rms = float(np.sqrt(np.mean(wave.astype(np.float64) ** 2)))
        if rms < 1e-5:
            raise ValueError(f'Silent generated samples: {identifier}')
        wav = output / 'wav' / f'{identifier}.wav'
        mp3 = output / 'audio' / f'{identifier}.mp3'
        # Float WAV retains the model's original samples without gain changes or clipping.
        sf.write(wav, wave, sample_rate, subtype='FLOAT')
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', str(wav),
                        '-codec:a', 'libmp3lame', '-b:a', '128k', str(mp3)], check=True)
        sample = dict(id=identifier, title=item.get('title', identifier), text=text,
                      wav=f'wav/{identifier}.wav', mp3=f'audio/{identifier}.mp3',
                      generation_seconds=generation_seconds, audio_seconds=len(wave) / sample_rate,
                      sample_rate=sample_rate, frames=len(wave), seed=seed, peak=peak, rms=rms,
                      runtime_dtype=dtype, inference_threads=args.threads,
                      peak_rss_bytes=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024,
                      samples_at_or_above_full_scale=int(np.count_nonzero(np.abs(wave) >= 1)),
                      wav_sha256=sha256(wav), mp3_sha256=sha256(mp3))
        manifest['samples'].append(sample)
        manifest['peak_rss_bytes'] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024
        atomic_json(output / 'manifest.json', manifest)
        print(json.dumps(sample, ensure_ascii=False), flush=True)
        notice(f'Completed sample {identifier}: audio={sample["audio_seconds"]:.3f}s, generation={generation_seconds:.3f}s, dtype={dtype}, peak RSS={manifest["peak_rss_bytes"]:,} bytes')
    manifest['complete'] = len(manifest['samples']) == args.limit
    manifest['total_generation_seconds'] = sum(item['generation_seconds'] for item in manifest['samples'])
    manifest['total_audio_seconds'] = sum(item['audio_seconds'] for item in manifest['samples'])
    atomic_json(output / 'manifest.json', manifest)
    notice(f'COMPLETE {len(manifest["samples"])} samples; peak RSS {manifest["peak_rss_bytes"]:,} bytes')


if __name__ == '__main__':
    main()
