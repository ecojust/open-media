#!/usr/bin/env python3
import argparse,array,datetime,hashlib,json,math,os,pathlib,shutil,subprocess,time,wave
ROOT=pathlib.Path(__file__).resolve().parent
CORPUS=pathlib.Path('/workspace/voice-audition-review/corpus.json')
CLI=pathlib.Path('/tmp/open-media-tts-audit/sherpa-onnx-v1.13.8-linux-x64-shared/bin/sherpa-onnx-offline-tts')

def sha(path):
 h=hashlib.sha256()
 with pathlib.Path(path).open('rb') as f:
  while chunk:=f.read(1024*1024):h.update(chunk)
 return h.hexdigest()
def record_file(path,base):return {'path':str(path.relative_to(base)),'bytes':path.stat().st_size,'sha256':sha(path)}
def setup(key):
 out=ROOT/key
 for folder in ['wav','mp3','logs','licenses','reference']: (out/folder).mkdir(parents=True,exist_ok=True)
 runtime={'name':'sherpa-onnx','version':'1.13.8','executable_sha256':sha(CLI),'platform':'Linux x86_64 CPU','runtime_download_bytes':28156791,'runtime_note':'Shared CPU inference runtime; separate from model download size. No Python tensor framework used.'}
 settings={'threads':1,'provider':'cpu','speed':1.0,'silence_scale':1.0,'max_sentences_per_batch':1,'mp3_bitrate':128000,'postprocessing':'MP3 encoding only. Original WAV retained; no pitch, loudness or tempo processing.','input_preprocessing':'Corpus Chinese text passed unchanged. Model tokenizer and supplied text-normalization rules are applied by the inference engine.'}
 meta={'schema':1,'id':key,'created_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'runtime':runtime,'settings':settings,'corpus_sha256':sha(CORPUS),'samples':[],'source_files':[],'status':'running'}
 if key=='melo-fp32':
  p=pathlib.Path('/workspace/tts-comparison-20261017/models/melo/vits-melo-tts-zh_en')
  names=['model.onnx','tokens.txt','lexicon.txt','date.fst','number.fst','LICENSE','README.md']
  args=[f'--vits-model={p}/model.onnx',f'--vits-lexicon={p}/lexicon.txt',f'--vits-tokens={p}/tokens.txt',f'--tts-rule-fsts={p}/date.fst,{p}/number.fst']
  meta.update(name='MeloTTS 中文 FP32',model_family='MeloTTS / VITS',voice='单一中英女声（模型内部 speaker_id=1，API sid=0）',model_download_bytes=167006755,model_required_bytes=sum((p/n).stat().st_size for n in names),model_weights_bytes=(p/'model.onnx').stat().st_size,license={'name':'MIT','text':'licenses/LICENSE','source':'https://github.com/myshell-ai/MeloTTS/blob/main/LICENSE'},source={'model':'https://huggingface.co/myshell-ai/MeloTTS-Chinese','converted_model':'https://huggingface.co/csukuangfj/vits-melo-tts-zh_en','archive':'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-melo-tts-zh_en.tar.bz2','archive_bytes':167006755,'archive_sha256':'e58351ed7149f290a54534538badd4077cdbe6fddc964b24d0bee870415d1514','download_note':'Reuse of this exact previously downloaded official archive; download bytes reflect the complete archive needed to reproduce the test.'})
  meta['source_files']=[record_file(p/n,p) for n in names]
  meta['settings'].update(sample_rate=44100,vits_noise_scale=.667,vits_noise_scale_w=.8,vits_length_scale=1,speaker_id=0,text_rules=['date.fst','number.fst'])
  shutil.copy2(p/'LICENSE',out/'licenses/LICENSE');shutil.copy2(p/'README.md',out/'licenses/MODEL_README.md')
 elif key=='zipvoice-distill-fp32':
  p=ROOT/'models/sherpa-onnx-zipvoice-distill-fp32-zh-en-emilia';v=ROOT/'downloads/vocos_24khz.onnx'
  original=pathlib.Path('/workspace/tts-comparison-20261017/matcha-ui-preview/matcha_zh_en_female.wav')
  expected='e9c6e266584978aa3c3a93a7eaea279d9045877b0acf29ecf7d675d32eada3ec';assert sha(original)==expected
  ref=out/'reference/matcha-reference.wav';shutil.copy2(original,ref)
  reftext='你好，这是一段语音试听。让文字拥有清晰自然的声音。'
  args=[f'--zipvoice-encoder={p}/encoder.onnx',f'--zipvoice-decoder={p}/decoder.onnx',f'--zipvoice-tokens={p}/tokens.txt',f'--zipvoice-data-dir={p}/espeak-ng-data',f'--zipvoice-lexicon={p}/lexicon.txt',f'--zipvoice-vocoder={v}',f'--reference-audio={ref}',f'--reference-text={reftext}','--num-steps=8']
  needed=[p/'encoder.onnx',p/'decoder.onnx',p/'tokens.txt',p/'lexicon.txt',*sorted(f for f in (p/'espeak-ng-data').rglob('*') if f.is_file())]
  meta.update(name='ZipVoice Distill FP32',model_family='ZipVoice / distilled flow matching',voice='同一段内置合成女声作为参考，无真人声音克隆',model_download_bytes=531957872,model_required_bytes=sum(f.stat().st_size for f in needed)+v.stat().st_size,model_weights_bytes=sum((p/n).stat().st_size for n in ['encoder.onnx','decoder.onnx'])+v.stat().st_size,license={'name':'CC-BY-NC（模型权重，研究试听）','text':'licenses/MODEL_README.md','source':'https://huggingface.co/k2-fsa/ZipVoice/blob/main/README.md','weights':'Official model README states CC-BY-NC due to Emilia training data; no license version specified. This test is research comparison, not commercial-use clearance.','code':{'name':'Apache-2.0','text':'licenses/CODE_LICENSE','source':'https://github.com/k2-fsa/ZipVoice/blob/master/LICENSE'},'text_frontend_note':'Bundled espeak-ng frontend data retains its original GPL-3.0-or-later license; runtime handled separately.'},source={'model':'https://huggingface.co/k2-fsa/ZipVoice','archive':'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/sherpa-onnx-zipvoice-distill-fp32-zh-en-emilia.tar.bz2','archive_bytes':477800463,'archive_sha256':'3b6729d03bf4ba64deeec113048bdbbe55dbc30580b609be76342e0099fd23a8','vocoder':'https://github.com/k2-fsa/sherpa-onnx/releases/download/vocoder-models/vocos_24khz.onnx','vocoder_bytes':54157409,'vocoder_sha256':'bcb3b970e384161c4d634f0bb9e999ff1c471b34c9bc0b1049a5014065ed3cc0'},reference_audio={'wav':'reference/matcha-reference.wav','sha256':expected,'text':reftext,'origin':'Previously generated Open Media builtin Matcha-TTS Chinese preview. Synthetic voice, not a real-person recording.','source_model':'matcha-icefall-zh-en 20251125-steps-3','source_manifest':'/workspace/open-media/src/assets/voice-previews/manifest.json','duration_seconds':5.059625,'sample_rate':16000})
  meta['source_files']=[record_file(f,p) for f in needed]+[{'path':'vocos_24khz.onnx','bytes':v.stat().st_size,'sha256':sha(v)}]
  meta['settings'].update(sample_rate=24000,num_steps=8,guidance_scale=1.0,t_shift=.5,feat_scale=.1,target_rms=.1)
  (out/'licenses/LICENSE').unlink(missing_ok=True);shutil.copy2(ROOT/'zipvoice-LICENSE',out/'licenses/CODE_LICENSE');shutil.copy2(ROOT/'zipvoice-README.md',out/'licenses/MODEL_README.md');shutil.copy2(ROOT/'zipvoice-card.json',out/'licenses/MODEL_METADATA.json')
 else:raise ValueError(key)
 meta['download_scope']='Exact official distribution archive(s) plus separately required vocoder weights. This counts all model payload needed for this download route, including archive companion files; excludes shared inference runtime and output audio.'
 meta['hardware']={'platform':'Linux x86_64','allocated_vcpus':2,'memory_limit_bytes':8589934592,'system_reported_memory_gib':9.7,'model_threads':1,'accelerator':'CPU only'}
 meta['sources']=[v for k,v in meta['source'].items() if isinstance(v,str) and v.startswith('https://')]
 meta['generation_notes']='每条新建原生进程；耗时包含冷加载模型、推理和 WAV 写出，部分测试共享 CPU。'
 meta['memory_notes']='Peak RSS of the fresh native synthesis process measured with wait4; excludes parent Python and unrelated processes. End-to-end generation timing includes cold model load and file output; shared machine activity can affect timings.'
 meta['model_version']='Official FP32 conversion released 2024-11-03, archive SHA256 recorded' if key=='melo-fp32' else 'Official distilled FP32 conversion released 2025-12-11, archive SHA256 recorded'
 meta['weights_bytes']=meta['model_weights_bytes']
 meta['model_unpacked_bytes']=meta['model_required_bytes']
 meta['model_files']=meta['source_files']
 meta['download_files']=[{'path':'vits-melo-tts-zh_en.tar.bz2','bytes':167006755}] if key=='melo-fp32' else [{'path':'zipvoice-distill-fp32.tar.bz2','bytes':477800463},{'path':'vocos_24khz.onnx','bytes':54157409}]
 meta['notes']=['第01条前端日志显示，AI 由官方未修改词典映射为 ay 9；原文没有替换为 A I。这里只记录输入音素，不代替实际试听判断。'] if key=='melo-fp32' else ['第01条前端日志显示，AI 由默认英文前端映射为 /eɪ aɪ/；原文没有替换为 A I。这里只记录输入音素，不代替实际试听判断。']
 return out,meta,args

def run(key):
 out,meta,args=setup(key); manifest=out/'manifest.json'
 if manifest.exists():
  old=json.loads(manifest.read_text())
  if old.get('corpus_sha256')==meta['corpus_sha256'] and old.get('settings')==meta['settings']:
   for s in old['samples']:
    if (out/s['wav']).is_file() and sha(out/s['wav'])==s['wav_sha256'] and (out/s['mp3']).is_file() and sha(out/s['mp3'])==s['mp3_sha256']:meta['samples'].append(s)
 for sample in meta['samples']:
  if sample['id']=='01':sample['notes']=meta['notes']
 manifest.write_text(json.dumps(meta,ensure_ascii=False,indent=2)+'\n')
 for row in json.loads(CORPUS.read_text()):
  if row['id'] in {s['id'] for s in meta['samples']}:continue
  text=row['texts']['zh'];sid=row['id'];wav=out/'wav'/f'{sid}.wav';mp3=out/'mp3'/f'{sid}.mp3';log=out/'logs'/f'{sid}.log';(out/'logs'/f'{sid}.txt').write_text(text)
  command=[str(CLI),*args,'--sid=0','--num-threads=1','--speed=1','--tts-silence-scale=1','--tts-max-num-sentences=1','--debug=true',f'--output-filename={wav}',text]
  start=time.monotonic()
  with log.open('w') as f:
   proc=subprocess.Popen(command,stdout=f,stderr=subprocess.STDOUT,env={**os.environ,'OMP_NUM_THREADS':'1','OPENBLAS_NUM_THREADS':'1'})
   while True:
    pid,status,usage=os.wait4(proc.pid,os.WNOHANG)
    if pid:break
    if time.monotonic()-start>900:proc.kill()
    time.sleep(.05)
   proc.returncode=os.waitstatus_to_exitcode(status)
  elapsed=time.monotonic()-start
  if proc.returncode:raise RuntimeError(f'{key}/{sid} exited {proc.returncode}: {log}')
  with wave.open(str(wav)) as w:
   rate=w.getframerate();channels=w.getnchannels();width=w.getsampwidth();frames=w.getnframes();data=w.readframes(frames)
  assert rate==meta['settings']['sample_rate'] and channels==1 and width==2
  values=array.array('h',data);peak=max(map(abs,values))/32768;rms=math.sqrt(sum((x/32768)**2 for x in values)/len(values));duration=frames/rate
  assert duration>1 and rms>.0001
  subprocess.run(['ffmpeg','-v','error','-y','-i',str(wav),'-map_metadata','-1','-codec:a','libmp3lame','-b:a','128k','-ar',str(rate),'-ac','1','-id3v2_version','0',str(mp3)],check=True)
  subprocess.run(['ffmpeg','-v','error','-i',str(mp3),'-f','null','-'],check=True)
  sample={'id':sid,'title':row['title'],'text':text,'focus':row['focus'],'wav':str(wav.relative_to(out)),'mp3':str(mp3.relative_to(out)),'generation_seconds':round(elapsed,3),'audio_seconds':duration,'real_time_factor':round(elapsed/duration,4),'peak_rss_bytes':usage.ru_maxrss*1024,'sample_rate':rate,'channels':channels,'peak':peak,'rms':rms,'clipped_samples':sum(abs(x)>=32767 for x in values),'wav_sha256':sha(wav),'mp3_sha256':sha(mp3),'wav_bytes':wav.stat().st_size,'mp3_bytes':mp3.stat().st_size,'command':command,'log':str(log.relative_to(out))}
  if sid=='01':sample['notes']=meta['notes']
  meta['samples'].append(sample);manifest.write_text(json.dumps(meta,ensure_ascii=False,indent=2)+'\n');print(json.dumps({k:sample[k] for k in ['id','generation_seconds','audio_seconds','peak_rss_bytes','peak']},ensure_ascii=False),flush=True)
 meta['status']='complete';meta['peak_rss_bytes']=max(s['peak_rss_bytes'] for s in meta['samples']);meta['total_generation_seconds']=sum(s['generation_seconds'] for s in meta['samples']);meta['total_audio_seconds']=sum(s['audio_seconds'] for s in meta['samples']);manifest.write_text(json.dumps(meta,ensure_ascii=False,indent=2)+'\n')
 print(key,'complete',len(meta['samples']),flush=True)
if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('model');args=parser.parse_args();run(args.model)
