"""Recover sample 10 from raw FLOAT chunks; retain original samples 01–09 byte-for-byte."""
import argparse
import hashlib
import json
import re
import platform
import shutil
import subprocess
from pathlib import Path
import numpy as np
import soundfile as sf

ORIGINAL_RUN = '39048766863'
ORIGINAL_COMMIT = '888274e894bee9c8d243cd4eeddb78e15085c789'
REPO = 'https://github.com/ecojust/open-media'
parser = argparse.ArgumentParser()
parser.add_argument('--original', type=Path, required=True)
parser.add_argument('--recovery', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--corpus', type=Path, required=True)
parser.add_argument('--recovery-run', required=True)
parser.add_argument('--recovery-commit', required=True)
args = parser.parse_args()

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def read(path):
    return json.loads(path.read_text())

def inventory(root, run, commit):
    data = read(root/'collection.json')
    assert str(data['sourceRun']) == run
    assert data['sourceCommit'] == commit
    seen, total = set(), 0
    for entry in data['files']:
        rel = Path(entry['path'])
        assert not rel.is_absolute() and '..' not in rel.parts
        path = root/rel
        assert path.is_file() and not path.is_symlink()
        assert path.stat().st_size == entry['bytes'] and digest(path) == entry['sha256'], path
        assert str(rel) not in seen
        seen.add(str(rel))
        total += entry['bytes']
    actual = {str(p.relative_to(root)) for p in root.rglob('*') if p.is_file() and p.name != 'collection.json'}
    assert seen == actual, (seen-actual, actual-seen)
    assert total == data['totalBytes']
    return data

def copy_provenance(source, target, include_chunks=False):
    target.mkdir(parents=True, exist_ok=True)
    for name in ['manifest.json','records.json','hardware.json','requirements-resolved.txt','logs',
                 'sources.json','reference.json','licenses'] + (['chunks'] if include_chunks else []):
        item = source/name
        if item.is_dir():
            shutil.copytree(item, target/name, dirs_exist_ok=True)
        elif item.exists():
            shutil.copy2(item, target/name)

original_collection = inventory(args.original, ORIGINAL_RUN, ORIGINAL_COMMIT)
recovery_collection = inventory(args.recovery, args.recovery_run, args.recovery_commit)
assert original_collection['sourceConclusion'] == 'failure'
assert recovery_collection['sourceConclusion'] == 'success'
corpus = read(args.corpus)
texts = {x['id']:x.get('text') or x['texts']['zh'] for x in corpus}
corpus_hash = digest(args.corpus)
out = args.output
assert not (out/'manifest.json').exists(), 'Use a new output directory, do not overwrite a prior comparison'
(out/'audio').mkdir(parents=True, exist_ok=True)
(out/'shards').mkdir(exist_ok=True)
shutil.copy2(args.original/'collection.json', out/'original-collection.json')
shutil.copy2(args.recovery/'collection.json', out/'recovery-collection.json')
samples, shards, result, seen = [], [], None, set()
original_manifests = sorted(args.original.glob('*/manifest.json'))
assert len(original_manifests) == 5
for path in original_manifests:
    data = read(path)
    records = {r['id']:r for r in read(path.parent/'records.json')}
    assert data['id'] == 'f5-v1-base-fp32' and data['model_download_bytes'] == 1402816013
    assert data['corpus_sha256'] == corpus_hash
    assert data['hardware']['githubRunId'] == ORIGINAL_RUN
    assert data['hardware']['githubCommit'] == ORIGINAL_COMMIT
    assert digest(path.parent/'reference.wav') == data['settings']['reference']['wavSha256']
    if result is None:
        result = data.copy()
        for item in ['licenses','reference.wav','reference.json','sources.json','requirements-resolved.txt']:
            source = path.parent/item
            if source.is_dir(): shutil.copytree(source, out/item, dirs_exist_ok=True)
            else: shutil.copy2(source, out/item)
    else:
        for key in ['id','runtime','model_download_bytes','model_files','settings','sources','license']:
            assert result[key] == data[key], key
    name = path.parent.name
    assert len(data['samples']) == (1 if name.endswith('-9') else 2)
    for item in data['samples']:
        sid = item['id']
        assert sid in texts and sid not in seen and sid != '10'
        assert item['text'] == texts[sid]
        wav = path.parent/item['wav']
        assert digest(wav) == item['wav_sha256'] == records[sid]['wavSha256']
        info = sf.info(wav)
        wave, sr = sf.read(wav, dtype='float64')
        assert info.subtype == 'PCM_16' and sr == 24000 and wave.ndim == 1 and np.isfinite(wave).all()
        assert abs(len(wave)/sr-item['audio_seconds']) < 1/sr
        subprocess.run(['ffmpeg','-v','error','-i',str(wav),'-f','null','-'], check=True)
        shutil.copy2(wav, out/'audio'/f'{sid}.wav')
        mp3 = wav.with_suffix('.mp3')
        assert digest(mp3) == records[sid]['mp3Sha256']
        shutil.copy2(mp3, out/'audio'/f'{sid}.mp3')
        copy = dict(item)
        copy.update(wav=f'audio/{sid}.wav', wav_subtype='PCM_16', raw_peak=records[sid]['peak'],
            stored_peak=float(np.max(np.abs(wave))), over_full_scale_sample_count=0,
            over_full_scale_sample_ratio=0.0, source_run_id=ORIGINAL_RUN, source_commit=ORIGINAL_COMMIT,
            source_artifact=name, source_wav_sha256=item['wav_sha256'],
            format_notes='Original PCM16 WAV copied byte-for-byte; original generation peak was below full scale.')
        assert 0.001 < records[sid]['peak'] < 1
        samples.append(copy)
        seen.add(sid)
    copy_provenance(path.parent, out/'shards'/name)
    shards.append({'name':name,'run_id':ORIGINAL_RUN,'commit':ORIGINAL_COMMIT,
                   'sample_ids':[x['id'] for x in data['samples']],'hardware':data['hardware'],
                   'peak_rss_bytes':data['peak_rss_bytes']})
assert seen == {f'{i:02d}' for i in range(1,10)}
reference, ref_sr = sf.read(out/'reference.wav', dtype='float32')
ref_text = result['settings']['reference']['text']
ref_frames = len(reference)//256
max_chars = int(len(ref_text.encode('utf-8'))/(len(reference)/ref_sr)*(22-len(reference)/ref_sr))
expected_chunks, current = [], ''
for sentence in re.split(r'(?<=[;:,.!?])\s+|(?<=[；：，。！？])',texts['10']):
    if not sentence: continue
    suffix = ' ' if len(sentence[-1].encode('utf-8')) == 1 else ''
    if len(current.encode('utf-8')) + len(sentence.encode('utf-8')) <= max_chars:
        current += sentence + suffix
    else:
        if current: expected_chunks.append(current.strip())
        current = sentence + suffix
if current: expected_chunks.append(current.strip())
assert len(expected_chunks) == 3
parts, segments = [], []
for part_index in range(3):
    paths = list(args.recovery.glob(f'*/chunks/10-{part_index}.json'))
    assert len(paths) == 1
    path = paths[0]
    data = read(path)
    artifact = path.parent.parent
    assert data['modelId'] == result['id'] and data['id'] == '10' and data['text'] == texts['10']
    assert data['chunkIndex'] == part_index and data['expectedChunkCount'] == 3
    assert data['allChunkTexts'] == expected_chunks and data['chunkText'] == expected_chunks[part_index]
    assert data['corpusSha256'] == corpus_hash
    assert data['referenceSha256'] == digest(out/'reference.wav') == digest(artifact/'reference.wav')
    assert data['source'] == read(out/'sources.json')
    assert data['hardware']['githubRunId'] == args.recovery_run
    assert data['hardware']['githubCommit'] == args.recovery_commit
    for key,value in {'steps':32,'dtype':'float32','device':'cpu','cfg_strength':2.0,
                      'sway_sampling_coef':-1.0,'threads':4,'reference_frames':ref_frames,
                      'reference_text':ref_text,'crossfade_seconds':0.15,'chunk_max_utf8_bytes':max_chars}.items():
        assert data['settings'][key] == value, key
    assert data['seed'] == 20261017+10*100+part_index
    speed = 0.3 if len(data['chunkText'].encode('utf-8')) < 10 else 1.0
    assert data['speed'] == speed
    expected_duration = ref_frames+int(ref_frames/len(ref_text.encode('utf-8'))*len(data['chunkText'].encode('utf-8'))/speed)
    assert data['framesIncludingReference'] == expected_duration
    wav = artifact/data['wav']
    assert digest(wav) == data['wavSha256'] and sf.info(wav).subtype == 'FLOAT'
    wave, sr = sf.read(wav, dtype='float32')
    assert sr == 24000 and wave.ndim == 1 and np.isfinite(wave).all()
    assert len(wave) == data['sampleCount'] and abs(len(wave)/sr-data['audioSeconds']) < 1/sr
    assert float(np.max(np.abs(wave))) == data['peak']
    assert int(np.count_nonzero(np.abs(wave)>1)) == data['overFullScaleSampleCount']
    parts.append(dict(data,source_artifact=artifact.name))
    segments.append(wave)
    copy_provenance(artifact, out/'shards'/artifact.name, include_chunks=True)
    shards.append({'name':artifact.name,'run_id':args.recovery_run,'commit':args.recovery_commit,
                   'sample_ids':['10'],'chunk_index':part_index,'hardware':data['hardware'],
                   'peak_rss_bytes':data['peakRssBytes']})
combined = segments[0]
for wave in segments[1:]:
    overlap = min(int(0.15*24000),len(combined),len(wave))
    fade = np.linspace(0,1,overlap)
    combined = np.concatenate([combined[:-overlap],combined[-overlap:]*(1-fade)+wave[:overlap]*fade,wave[overlap:]])
assert np.isfinite(combined).all()
wav = out/'audio/10.wav'
sf.write(wav, combined, 24000, subtype='FLOAT')
subprocess.run(['ffmpeg','-v','error','-y','-i',str(wav),'-codec:a','libmp3lame','-b:a','128k',str(wav.with_suffix('.mp3'))],check=True)
subprocess.run(['ffmpeg','-v','error','-i',str(wav),'-f','null','-'],check=True)
stored, sr = sf.read(wav, dtype='float32')
assert np.array_equal(stored, combined.astype(np.float32))
over_count = int(np.count_nonzero(np.abs(combined)>1))
recovered = {'id':'10','title':next(x['title'] for x in corpus if x['id']=='10'),'text':texts['10'],
    'wav':'audio/10.wav','wav_sha256':digest(wav),'wav_subtype':'FLOAT','audio_seconds':len(combined)/24000,
    'generation_seconds':sum(p['seconds'] for p in parts),
    'generation_notes':'Sum of three separately measured chunk inference times from a recovery workflow. Chunks ran in parallel; this is compute time, not elapsed wall time. Excludes model loads and local crossfade/encoding. Original run completed inference but discarded sample 10 because a peak above 1 triggered a save-time assertion.',
    'started_at':min(p['startedAt'] for p in parts),'finished_at':max(p['finishedAt'] for p in parts),
    'raw_peak':float(np.max(np.abs(combined))),'stored_peak':float(np.max(np.abs(stored))),
    'raw_rms':float(np.sqrt(np.mean(combined**2))), 'over_full_scale_sample_count':over_count,
    'over_full_scale_sample_ratio':over_count/len(combined),
    'format_notes':'FLOAT WAV preserves the generated waveform including finite samples above full scale. No gain normalization or clipping. MP3 is a lossy preview derivative.',
    'source_run_id':args.recovery_run,'source_commit':args.recovery_commit,
    'original_failed_run_id':ORIGINAL_RUN,'original_failed_commit':ORIGINAL_COMMIT,
    'chunks':parts,'assembly':'Same original sequential numpy.linspace 0.15-second crossfade, then FLOAT WAV serialization.',
    'assembly_environment':{'platform':platform.platform(),'python':platform.python_version(),
        'numpy':np.__version__,'soundfile':sf.__version__,'libwav':sf.__libsndfile_version__,
        'ffmpeg':subprocess.check_output(['ffmpeg','-version'],text=True).splitlines()[0],
        'note':'Local waveform concatenation and encoding only; no local model inference is included.'}}
samples.append(recovered)
result['samples'] = sorted(samples,key=lambda x:x['id'])
result['peak_rss_bytes'] = max(x['peak_rss_bytes'] for x in shards)
result['memory_notes'] = 'Maximum observed process ru_maxrss among the successfully saved original sample records and the three saved recovery chunks. This is not the sum of concurrent runners and does not capture the unsaved failed sample 10 process peak.'
result['settings']['chunking'] = 'Unchanged upstream UTF-8 byte-based sentence splitting targeting 22 seconds including reference. Original samples 01–09 run sequential chunks; sample 10 recovers three unchanged chunks in parallel, then combines them in original order.'
result['settings']['postprocessing'] = 'Original upstream crossfade and RMS restoration only. Samples 01–09 retain original PCM16 files; recovered 10 uses FLOAT to preserve finite above-full-scale samples. No additional gain normalization, denoising, pitch or tempo edits. MP3 files are lossy listening derivatives.'
result['hardware'] = {'provider':'GitHub Actions','shards':shards,'note':'Two documented runs; hardware and timings are per shard, not identical-load performance rankings.'}
result['provenance'] = {'original_run_id':ORIGINAL_RUN,'original_commit':ORIGINAL_COMMIT,
    'recovery_run_id':args.recovery_run,'recovery_commit':args.recovery_commit,
    'original_url':f'{REPO}/actions/runs/{ORIGINAL_RUN}','recovery_url':f'{REPO}/actions/runs/{args.recovery_run}',
    'original_sample_ids':[f'{i:02d}' for i in range(1,10)],'recovered_sample_ids':['10'],
    'original_manifests_retained':True,'original_wav_bytes_unchanged':True,'recovery_chunks_retained':True,
    'local_incomplete_run_included':False,'collections':['original-collection.json','recovery-collection.json']}
result['notes'].extend([
    '01–09 沿用原运行的 PCM16 WAV 原文件（字节不变）；第10条原推理成功但峰值1.0092947483062744触发保存前断言，未留下WAV，因此用完全相同模型、参考、32步、seed和分块参数仅重新生成其3个分块。',
    '第10条由第二次恢复运行的3片原始 FLOAT WAV 按原0.15秒交叉淡化拼接；FLOAT保留超满量程样本，没有通过降低音量或截幅掩盖问题。每条格式、来源及峰值已分别记录。',
    '第10条生成时间为三个并行分块的合成时间之和，不是整句墙钟时间，不能与其他顺序运行样本当作同条件性能对比。原始日志、逐片元数据、FLOAT分块以及两次运行的来源信息均保留。'])
(out/'recovery-assembly.json').write_text(json.dumps(recovered,ensure_ascii=False,indent=2))
(out/'manifest.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
print(json.dumps({'samples':len(samples),'duration':sum(x['audio_seconds'] for x in samples),
                 'recovery_peak':recovered['raw_peak'],'over_full_scale_count':over_count,
                 'recovery_seconds_sum':recovered['generation_seconds']},indent=2))
