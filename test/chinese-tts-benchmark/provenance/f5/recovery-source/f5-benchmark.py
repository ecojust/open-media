"""CPU-only comparison using the pinned upstream F5 model and inference settings.

Only the training package initializer is bypassed. DiT, CFM, tokenization and
mel processing are unmodified upstream modules. Generation, duration estimation,
RMS handling and chunk crossfading match the upstream inference helper.
"""
import argparse
import datetime
import hashlib
import json
import os
import re
import resource
import subprocess
import sys
import time
import types
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--start-index', type=int, default=1)
parser.add_argument('--count', type=int, default=10)
parser.add_argument('--chunk-index', type=int, default=None, help='Recover one unchanged upstream chunk; requires --count 1')
parser.add_argument('--threads', type=int, default=2)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--source-dir', type=Path, required=True)
parser.add_argument('--corpus', type=Path, required=True)
parser.add_argument('--reference', type=Path, required=True)
args = parser.parse_args()
if args.chunk_index is not None and (args.count != 1 or args.chunk_index < 0):
    parser.error('--chunk-index requires --count 1 and a nonnegative index')
ROOT = args.output.resolve()
(ROOT/('chunks' if args.chunk_index is not None else 'audio')).mkdir(parents=True, exist_ok=True)
os.environ['OMP_NUM_THREADS'] = str(args.threads)
os.environ['MKL_NUM_THREADS'] = str(args.threads)
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
sys.path.insert(0, str(args.source_dir.resolve() / 'src'))
# Upstream model/__init__ imports the training stack; inference does not use it.
model_namespace = types.ModuleType('f5_tts.model')
model_namespace.__path__ = [str(args.source_dir.resolve() / 'src/f5_tts/model')]
sys.modules['f5_tts.model'] = model_namespace

import numpy as np
import soundfile as sf
import torch
from safetensors.torch import load_file
from f5_tts.model.backbones.dit import DiT
from f5_tts.model.cfm import CFM
from f5_tts.model.utils import convert_char_to_pinyin, get_tokenizer
from vocos import Vocos

torch.set_num_threads(args.threads)
torch.set_num_interop_threads(1)
started = time.perf_counter()
vocabulary, count = get_tokenizer(str(ROOT / 'models/f5/vocab.txt'), 'custom')
model = CFM(
    transformer=DiT(dim=1024, depth=22, heads=16, ff_mult=2, text_dim=512,
        text_mask_padding=True, qk_norm=None, conv_layers=4, pe_attn_head=None,
        attn_backend='torch', attn_mask_enabled=False, checkpoint_activations=False,
        text_num_embeds=count, mel_dim=100),
    mel_spec_kwargs={'n_fft':1024, 'hop_length':256, 'win_length':1024,
        'n_mel_channels':100, 'target_sample_rate':24000, 'mel_spec_type':'vocos'},
    odeint_kwargs={'method':'euler'}, vocab_char_map=vocabulary,
).to(device='cpu', dtype=torch.float32)
weights = load_file(str(ROOT / 'models/f5/model_1250000.safetensors'), device='cpu')
weights = {k.replace('ema_model.', ''):v for k,v in weights.items() if k not in ['initted','step']}
for key in ['mel_spec.mel_stft.mel_scale.fb','mel_spec.mel_stft.spectrogram.window']:
    weights.pop(key, None)
model.load_state_dict(weights)
del weights
model.eval()
vocoder = Vocos.from_hparams(str(ROOT / 'models/vocos/config.yaml'))
vocoder.load_state_dict(torch.load(str(ROOT / 'models/vocos/pytorch_model.bin'), map_location='cpu', weights_only=True))
vocoder.eval()
load_seconds = time.perf_counter() - started
print('loaded', load_seconds, flush=True)

reference, sample_rate = sf.read(args.reference, dtype='float32')
assert sample_rate == 24000 and reference.ndim == 1
audio = torch.from_numpy(reference).unsqueeze(0)
reference_rms = torch.sqrt(torch.mean(audio.square()))
if reference_rms < 0.1:
    audio = audio * 0.1 / reference_rms
ref_text = '从录制画面到整理素材，再到添加字幕和导出成片，这款软件把常用的创作工具放在了一起。'
ref_frames = audio.shape[-1] // 256
max_chars = int(len(ref_text.encode('utf-8')) / (audio.shape[-1] / sample_rate) * (22 - audio.shape[-1] / sample_rate))

def chunks(text):
    result, current = [], ''
    for sentence in re.split(r'(?<=[;:,.!?])\s+|(?<=[；：，。！？])', text):
        if not sentence:
            continue
        suffix = ' ' if len(sentence[-1].encode('utf-8')) == 1 else ''
        if len(current.encode('utf-8')) + len(sentence.encode('utf-8')) <= max_chars:
            current += sentence + suffix
        else:
            if current:
                result.append(current.strip())
            current = sentence + suffix
    if current:
        result.append(current.strip())
    return result

corpus = json.loads(args.corpus.read_text())
records = json.loads((ROOT/'records.json').read_text()) if (ROOT/'records.json').exists() else []
for index, entry in enumerate(corpus, 1):
    if index < args.start_index or index >= args.start_index + args.count:
        continue
    began = datetime.datetime.now(datetime.timezone.utc).isoformat()
    start = time.perf_counter()
    text = entry.get('text') or entry['texts']['zh']
    segments, chunk_records = [], []
    text_chunks = chunks(text)
    if args.chunk_index is not None and args.chunk_index >= len(text_chunks):
        raise ValueError(f'Chunk index {args.chunk_index} outside {len(text_chunks)} chunks')
    for part_index, text_chunk in enumerate(text_chunks):
        if args.chunk_index is not None and part_index != args.chunk_index:
            continue
        local_start = time.perf_counter()
        seed = 20261017 + index * 100 + part_index
        speed = 0.3 if len(text_chunk.encode('utf-8')) < 10 else 1.0
        duration = ref_frames + int(ref_frames / len(ref_text.encode('utf-8')) * len(text_chunk.encode('utf-8')) / speed)
        with torch.inference_mode():
            generated, trajectory = model.sample(cond=audio, text=convert_char_to_pinyin([ref_text+text_chunk]),
                duration=duration, steps=32, cfg_strength=2.0, sway_sampling_coef=-1.0, seed=seed)
            del trajectory
            mel = generated[:, ref_frames:, :].float().permute(0,2,1)
            wave = vocoder.decode(mel)
            if reference_rms < 0.1:
                wave = wave * reference_rms / 0.1
            samples = wave.squeeze().cpu().numpy()
        segments.append(samples)
        chunk_records.append({'text':text_chunk, 'seed':seed, 'speed':speed, 'framesIncludingReference':duration,
            'seconds':time.perf_counter()-local_start, 'audioSeconds':len(samples)/24000})
        print(entry['id'], 'chunk', part_index, chunk_records[-1], flush=True)
        if args.chunk_index is not None:
            assert np.isfinite(samples).all() and float(np.max(np.abs(samples))) > 0.001
            wav = ROOT/'chunks'/f"{entry['id']}-{part_index}.wav"
            sf.write(wav, samples, 24000, subtype='FLOAT')
            over_count = int(np.count_nonzero(np.abs(samples) > 1.0))
            chunk_record = {
                'schema':1, 'modelId':'f5-v1-base-fp32', 'id':entry['id'], 'title':entry['title'],
                'text':text, 'chunkText':text_chunk, 'chunkIndex':part_index,
                'expectedChunkCount':len(text_chunks), 'allChunkTexts':text_chunks,
                **chunk_records[-1], 'text':text,
                'startedAt':began, 'finishedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'loadSeconds':load_seconds, 'torchThreads':args.threads,
                'peakRssBytes':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss*1024,
                'sampleRate':24000, 'channels':1, 'sampleCount':len(samples), 'wavSubtype':'FLOAT',
                'peak':float(np.max(np.abs(samples))), 'rms':float(np.sqrt(np.mean(samples**2))),
                'overFullScaleSampleCount':over_count, 'overFullScaleSampleRatio':over_count/len(samples),
                'wav':str(wav.relative_to(ROOT)), 'wavSha256':hashlib.sha256(wav.read_bytes()).hexdigest(),
                'referenceSha256':hashlib.sha256(args.reference.read_bytes()).hexdigest(),
                'corpusSha256':hashlib.sha256(args.corpus.read_bytes()).hexdigest(),
                'source':json.loads((ROOT/'sources.json').read_text()),
                'hardware':json.loads((ROOT/'hardware.json').read_text()),
                'settings':{'device':'cpu','dtype':'float32','steps':32,'cfg_strength':2.0,
                    'sway_sampling_coef':-1.0,'ode_method':'euler','sample_rate':24000,
                    'threads':args.threads,'interop_threads':1,'crossfade_seconds':0.15,
                    'reference_text':ref_text,'reference_frames':ref_frames,'reference_rms':float(reference_rms),
                    'target_rms':0.1,'chunk_max_utf8_bytes':max_chars,
                    'postprocessing':'Raw individual vocoder chunk after unchanged upstream RMS restoration; FLOAT WAV preserves finite samples above full scale. No gain normalization, clipping or crossfade at this stage.'}}
            wav.with_suffix('.json').write_text(json.dumps(chunk_record,ensure_ascii=False,indent=2))
            print('RECOVERY COMPLETE', entry['id'], part_index, 'peak',chunk_record['peak'],'over full scale',over_count,flush=True)
    if args.chunk_index is not None:
        continue
    combined = segments[0]
    for samples in segments[1:]:
        overlap = min(int(0.15*24000),len(combined),len(samples))
        fade = np.linspace(0,1,overlap)
        combined = np.concatenate([combined[:-overlap],combined[-overlap:]*(1-fade)+samples[:overlap]*fade,samples[overlap:]])
    generation_seconds = time.perf_counter()-start
    peak = float(np.max(np.abs(combined)))
    assert np.isfinite(combined).all() and peak > 0.001
    over_count = int(np.count_nonzero(np.abs(combined) > 1.0))
    wav = ROOT/'audio'/f"{entry['id']}.wav"
    mp3 = wav.with_suffix('.mp3')
    sf.write(wav, combined, 24000, subtype='FLOAT')
    subprocess.run(['ffmpeg','-v','error','-y','-i',str(wav),'-codec:a','libmp3lame','-b:a','128k',str(mp3)], check=True)
    record = {'id':entry['id'], 'title':entry['title'], 'text':text, 'startedAt':began,
        'finishedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'generationSeconds':generation_seconds, 'loadSeconds':load_seconds,
        'torchThreads':args.threads,
        'peakRssBytes':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss*1024,
        'durationSeconds':len(combined)/24000, 'sampleRate':24000, 'channels':1,
        'peak':peak, 'rms':float(np.sqrt(np.mean(combined**2))),
        'wavSubtype':'FLOAT','overFullScaleSampleCount':over_count,
        'overFullScaleSampleRatio':over_count/len(combined),
        'wav':str(wav.relative_to(ROOT)), 'mp3':str(mp3.relative_to(ROOT)),
        'wavSha256':hashlib.sha256(wav.read_bytes()).hexdigest(),
        'mp3Sha256':hashlib.sha256(mp3.read_bytes()).hexdigest(), 'chunks':chunk_records}
    records=[r for r in records if r['id']!=entry['id']]+[record]
    records.sort(key=lambda x:x['id'])
    (ROOT/'records.json').write_text(json.dumps(records,ensure_ascii=False,indent=2))
    print('COMPLETE',entry['id'],round(generation_seconds,2),'s, audio',record['durationSeconds'],'s, peak',peak,flush=True)
