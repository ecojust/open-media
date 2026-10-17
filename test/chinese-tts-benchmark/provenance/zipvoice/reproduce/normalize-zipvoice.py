#!/usr/bin/env python3
"""Restore the upstream Chinese normalizer; retain the initial ONNX test unchanged."""
import array,copy,datetime,hashlib,importlib.util,json,math,os,pathlib,shutil,subprocess,sys,time,wave
ROOT=pathlib.Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT/'frontend-site'))
source_dir=ROOT/'evidence/official-normalizer'
spec=importlib.util.spec_from_file_location('zipvoice_upstream_normalizer',source_dir/'normalizer.py');upstream=importlib.util.module_from_spec(spec);spec.loader.exec_module(upstream)
normalizer=upstream.ChineseTextNormalizer()
raw_dir=ROOT/'zipvoice-distill-fp32'; out=ROOT/'zipvoice-distill-fp32-zh-frontend'
for name in ['wav','mp3','logs','reference','licenses','normalization']: (out/name).mkdir(parents=True,exist_ok=True)
def sha(p):
 h=hashlib.sha256()
 with pathlib.Path(p).open('rb') as f:
  while b:=f.read(1024*1024):h.update(b)
 return h.hexdigest()
def timestamp(p):return datetime.datetime.fromtimestamp(p.stat().st_mtime,datetime.timezone.utc).isoformat()
raw=json.loads((raw_dir/'manifest.json').read_text());assert raw['status']=='complete' and len(raw['samples'])==10
meta=copy.deepcopy(raw);meta.update(id='zipvoice-distill-fp32-zh-frontend',name='ZipVoice Distill FP32 · 官方中文前端',status='running',samples=[],created_at=datetime.datetime.now(datetime.timezone.utc).isoformat())
meta['settings']['input_preprocessing']='Original corpus text is passed automatically through the unmodified upstream ChineseTextNormalizer.normalize (cn2an.transform an2cn); both original text and actual normalized_text are retained. No hand editing.'
meta['settings']['zipvoice_chunking']={'min_char_in_sentence':30,'max_char_in_sentence':200,'note':'Actual defaults in this implementation; generic tts-max-num-sentences is not used by ZipVoice.'}
meta['notes']=['使用固定版本的官方中文数字规范化函数恢复中文前端，保留原文与实际模型输入；不手改字词、AI、数字或标点。','10条中只有09规范化后改变，重新真实合成；其余9条输入与模型参数完全相同，复用原始真实WAV，并保留源文件hash、原生成耗时和时间。','第01条前端日志记录 AI 映射为 /eɪ aɪ/；这里只陈列前端处理，不做主观自然度评分。']
meta['generation_notes']='第09条使用官方中文规范化后重新运行真实推理；其余9条输入/模型参数不变，明确复用原始WAV，耗时与生成时间沿用源记录。原始未恢复中文数字前端的10条另存诊断组。'
meta['implementation_notes']=['sherpa-onnx 1.13.8 的 ZipVoice 实现忽略通用 tts-rule-fsts；因此采用原ZipVoice项目的 ChineseTextNormalizer（cn2an.transform an2cn）在CPU推理前自动规范化。','原始输入文本完整保存。此配置称“官方中文前端”，不伪称为默认ONNX配置。','数字规范化应用到此组中文语料全文；ONNX随后继续使用原有分词/音素转换。未替换整套原项目分词器。']
source=json.loads((source_dir/'source.json').read_text())
for f in source['files']:
 assert sha(source_dir/f['path'])==f['sha256']
 shutil.copy2(source_dir/f['path'],out/'normalization'/f['path'])
shutil.copy2(source_dir/'source.json',out/'normalization/source.json')
wheels=[{'path':p.name,'bytes':p.stat().st_size,'sha256':sha(p)} for p in sorted((ROOT/'frontend-wheels').glob('*.whl'))]
meta['normalization']={'source':source,'class':'ChineseTextNormalizer','method':'normalize','parameters':{'cn2an_transform_mode':'an2cn'},'application':'Automatic normalization of the entire supplied Chinese corpus string before the ONNX frontend. Original text is retained separately.','dependencies':{'cn2an':'0.5.23','inflect':'7.5.0'},'dependency_download_bytes':sum(f['bytes'] for f in wheels),'dependency_downloads':wheels,'installed_dependency_bytes':sum(p.stat().st_size for p in (ROOT/'frontend-site').rglob('*') if p.is_file()),'code_bytes':(source_dir/'normalizer.py').stat().st_size,'code_sha256':sha(source_dir/'normalizer.py'),'size_note':'Pure-Python frontend dependencies are listed separately from unchanged model weights and shared native runtime; full upstream normalizer module imports the English inflect dependency even though this corpus uses ChineseTextNormalizer only.'}
meta['runtime']['frontend_download_bytes']=meta['normalization']['dependency_download_bytes'];meta['runtime']['frontend_source_bytes']=meta['normalization']['code_bytes']
meta['diagnostic_group']={'model_id':raw['id'],'manifest':str(raw_dir/'manifest.json'),'manifest_sha256':sha(raw_dir/'manifest.json'),'sample_count':10,'purpose':'Original native ONNX frontend output before restoring upstream Chinese number normalization; preserved without overwriting.'}
shutil.copytree(raw_dir/'licenses',out/'licenses',dirs_exist_ok=True);shutil.copytree(raw_dir/'reference',out/'reference',dirs_exist_ok=True)
manifest=out/'manifest.json'
for src in raw['samples']:
 sample=copy.deepcopy(src);sid=sample['id'];original=src['text'];started=time.monotonic();normalized=normalizer.normalize(original);sample['normalization_seconds']=time.monotonic()-started;sample['normalized_text']=normalized
 sample['generated_at']=timestamp(raw_dir/src['wav']);sample['generated_at_note']='Original WAV filesystem modification timestamp observed after generation (UTC).'
 if original==normalized:
  for field in ['wav','mp3','log']:
   shutil.copy2(raw_dir/src[field],out/src[field])
  shutil.copy2(raw_dir/'logs'/f'{sid}.txt',out/'logs'/f'{sid}.txt')
  assert sha(out/sample['wav'])==src['wav_sha256'] and sha(out/sample['mp3'])==src['mp3_sha256']
  sample['reused']=True;sample['reused_from']={'model_id':raw['id'],'sample_id':sid,'wav':str(raw_dir/src['wav']),'wav_sha256':src['wav_sha256'],'mp3_sha256':src['mp3_sha256'],'generation_seconds':src['generation_seconds'],'generated_at':sample['generated_at'],'reason':'Automatic normalization returns exactly the original input; model weights, voice reference, synthesis settings and input bytes are unchanged.'}
  sample['notes']=list(src.get('notes',[]))+['本条官方中文规范化结果与原文完全一致；音频字节与原始真实生成结果相同，已记录复用来源和SHA256。']
 else:
  wav=out/'wav'/f'{sid}.wav';mp3=out/'mp3'/f'{sid}.mp3';log=out/'logs'/f'{sid}.log'
  command=list(src['command']);command=[f'--output-filename={wav}' if x.startswith('--output-filename=') else f'--reference-audio={out}/reference/matcha-reference.wav' if x.startswith('--reference-audio=') else x for x in command];assert command[-1]==original;command[-1]=normalized
  (out/'logs'/f'{sid}.original.txt').write_text(original);(out/'logs'/f'{sid}.txt').write_text(normalized)
  started=time.monotonic()
  with log.open('w') as f:
   proc=subprocess.Popen(command,stdout=f,stderr=subprocess.STDOUT,env={**os.environ,'OMP_NUM_THREADS':'1','OPENBLAS_NUM_THREADS':'1'})
   while True:
    pid,status,usage=os.wait4(proc.pid,os.WNOHANG)
    if pid:break
    if time.monotonic()-started>900:proc.kill()
    time.sleep(.05)
   proc.returncode=os.waitstatus_to_exitcode(status)
  elapsed=time.monotonic()-started
  if proc.returncode:raise RuntimeError(f'Synthesis failed: {log}')
  with wave.open(str(wav)) as w:
   rate=w.getframerate();assert (rate,w.getnchannels(),w.getsampwidth())==(24000,1,2);frames=w.getnframes();data=w.readframes(frames)
  a=array.array('h',data);duration=frames/rate;peak=max(map(abs,a))/32768;rms=math.sqrt(sum((x/32768)**2 for x in a)/len(a));assert duration>1 and rms>.0001
  subprocess.run(['ffmpeg','-v','error','-y','-i',str(wav),'-map_metadata','-1','-codec:a','libmp3lame','-b:a','128k','-ar','24000','-ac','1','-id3v2_version','0',str(mp3)],check=True)
  subprocess.run(['ffmpeg','-v','error','-i',str(mp3),'-f','null','-'],check=True)
  sample.update(reused=False,generation_seconds=round(elapsed,3),audio_seconds=duration,real_time_factor=round(elapsed/duration,4),peak_rss_bytes=usage.ru_maxrss*1024,peak=peak,rms=rms,clipped_samples=sum(abs(x)>=32767 for x in a),wav_sha256=sha(wav),mp3_sha256=sha(mp3),wav_bytes=wav.stat().st_size,mp3_bytes=mp3.stat().st_size,command=command,generated_at=timestamp(wav),generated_at_note='New WAV filesystem modification timestamp observed after generation (UTC).')
  sample['notes']=['本条由未修改的官方 ChineseTextNormalizer 自动展开中文数字；页面同时列出原始语料与真实推理输入。没有手工改写。','重新真实合成；未规范化的原始音频完整保存在诊断组，供直接比较。']
 meta['samples'].append(sample);manifest.write_text(json.dumps(meta,ensure_ascii=False,indent=2)+'\n');print(sid,'reused' if sample['reused'] else 'generated',sample['audio_seconds'],flush=True)
meta.update(status='complete',reused_sample_count=sum(s['reused'] for s in meta['samples']),new_generation_seconds=sum(s['generation_seconds'] for s in meta['samples'] if not s['reused']),total_generation_seconds=sum(s['generation_seconds'] for s in meta['samples']),total_audio_seconds=sum(s['audio_seconds'] for s in meta['samples']),peak_rss_bytes=max(s['peak_rss_bytes'] for s in meta['samples']))
manifest.write_text(json.dumps(meta,ensure_ascii=False,indent=2)+'\n');print('Complete:',manifest)
