import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--output',type=Path,required=True)
parser.add_argument('--corpus',type=Path,required=True)
parser.add_argument('--reference-metadata',type=Path,required=True)
args=parser.parse_args()
root=args.output.resolve()
sources = json.loads((root/'sources.json').read_text())
reference = json.loads(args.reference_metadata.read_text())
records = json.loads((root/'records.json').read_text())
files = [x for x in sources['files'] if not x['path'].endswith('README.md')]
manifest = {
    'schema':1,
    'id':'f5-v1-base-fp32',
    'name':'F5-TTS v1 Base FP32',
    'model_family':'F5-TTS',
    'voice':'基于本地生成的中英女声参考（纯合成参考，无真人录音）',
    'model_download_bytes':sum(x['bytes'] for x in files),
    'weights_bytes':sum(x['bytes'] for x in files if x['path'].endswith(('.safetensors','.bin'))),
    'download_scope':'完整推理所需声学权重、词表、24kHz声码器权重与配置；分别从固定版本原始文件下载。没有压缩包；不含运行环境、许可说明及参考WAV。',
    'runtime_size_notes':'复用CPU版PyTorch与音频依赖，环境体积未计入模型下载量；没有安装或使用CUDA。依赖版本见requirements-resolved.txt。',
    'model_files':[{'path':x['path'],'bytes':x['bytes'],'sha256':x['sha256']} for x in files],
    'peak_rss_bytes':max(x['peakRssBytes'] for x in records),
    'memory_notes':'Linux resource.getrusage(RUSAGE_SELF).ru_maxrss 实测进程峰值RSS；包含模型加载、参考处理和合成。不代表安装体积或跨机器最低内存。',
    'runtime':{'python':__import__('platform').python_version(),'torch':importlib.metadata.version('torch'),
        'torchaudio':importlib.metadata.version('torchaudio'),'vocos':importlib.metadata.version('vocos'),
        'source_commit':sources['code']['commit'],'device':'cpu','dtype':'float32',
        'inference':'Unmodified upstream DiT, CFM, text tokenizer and mel processing; direct inference skips only Trainer/UI/ASR imports.'},
    'hardware':json.loads((root/'hardware.json').read_text()),
    'settings':{'steps':32,'cfg_strength':2.0,'sway_sampling_coef':-1.0,'ode_method':'euler',
        'sample_rate':24000,'threads':records[0].get('torchThreads',2),'interop_threads':1,'speed':'默认1.0；UTF-8字节数小于10的短片段按上游逻辑使用0.3，实际值见samples[].chunks[].speed','target_rms':0.1,
        'chunking':'Upstream UTF-8 byte-based sentence splitting targeting 22 seconds including the reference; chunks run sequentially.',
        'crossfade_seconds':0.15,'random_seed':'20261017 + corpus_number*100 + chunk_number',
        'text_normalization':'Exact original Chinese input. Upstream rjieba/pypinyin conversion only; numbers, English abbreviations and punctuation were not manually rewritten.',
        'reference':reference,'postprocessing':'Upstream chunk crossfade and RMS restoration only; no extra denoising, pitch, tempo or loudness processing. FLOAT WAV retains finite samples above full scale without gain normalization; MP3 128kbps is a lossy listening derivative.'},
    'sources':[{'url':sources['code']['repository'],'revision':sources['code']['commit'],'role':'inference source'},
        *[{'url':'https://huggingface.co/'+m['repository'],'revision':m['revision'],'license':m['license']} for m in sources['models']]],
    'license':{'weights':'CC-BY-NC-4.0','inference_code':'MIT','vocoder':'MIT',
        'texts':['licenses/CC-BY-NC-4.0.txt','licenses/F5-code-MIT.txt','licenses/Vocos-MIT.txt'],
        'restriction':'非商业研究试听；未作为产品内置或可下载模型发布。'},
    'notes':[
        '这是模型对给定10条中文文本的真实离线CPU合成（本机或云端 runner 见 hardware），不是原公开试听，也没有使用云端语音服务。',
        '该模型由参考音频决定声线。本次采用此前本地模型生成的女声，语气及音质可能受到这段参考声音影响；并非展示一款模型的全部音色能力。',
        '与其他模型的运行环境和并发负载可能不同，生成耗时不能作为严格同条件性能排名。',
        '上游权重为非商业许可；本次只供研究比较，不能据此假定适合商业分发。'
    ],
    'samples':[{'id':r['id'],'title':r['title'],'text':r['text'],'wav':r['wav'],
        'generation_seconds':r['generationSeconds'],'audio_seconds':r['durationSeconds'],
        'wav_sha256':r['wavSha256'],'started_at':r['startedAt'],'finished_at':r['finishedAt'],
        'generation_notes':'模型已载入后的逐条合成时长，包含分句处理、声码器和拼接，排除文件编码及首次模型加载。原始执行日志和分句参数见records.json。',
        'load_seconds':r['loadSeconds'],'chunks':r['chunks'],
        'wav_subtype':r.get('wavSubtype','PCM_16'),'raw_peak':r['peak'],
        'over_full_scale_sample_count':r.get('overFullScaleSampleCount',0),
        'over_full_scale_sample_ratio':r.get('overFullScaleSampleRatio',0)} for r in records],
    'corpus_sha256':hashlib.sha256(args.corpus.read_bytes()).hexdigest(),
}
(root/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2))
print('samples',len(records),'bytes',manifest['model_download_bytes'],'peakRSS',manifest['peak_rss_bytes'])
