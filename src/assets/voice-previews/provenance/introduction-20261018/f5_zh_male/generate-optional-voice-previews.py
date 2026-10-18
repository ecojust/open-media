#!/usr/bin/env python3
"""Regenerate optional auditions from verified installed weights, without downloads."""
import argparse
import datetime
import importlib.util
import json
from pathlib import Path
import platform
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'src/assets/voice-previews'
spec = importlib.util.spec_from_file_location('voice_generation', ROOT / 'scripts/generate-male-voice-previews.py')
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)
VOICES = ('zipvoice_zh_female', 'f5_zh_female', 'qwen3_serena',
          'zipvoice_zh_male', 'f5_zh_male', 'qwen3_uncle_fu')
MODELS = {voice: ('zipvoice-distill-fp32' if voice.startswith('zipvoice_') else
                 'f5-v1-base-fp32' if voice.startswith('f5_') else 'qwen3-tts-1.7b-serena') for voice in VOICES}


def snapshot(voice, runtime):
    directory = ASSETS / 'provenance/introduction-20261018' / voice
    directory.mkdir(parents=True, exist_ok=True)
    result = dict(platform=platform.platform(), python=platform.python_version(),
                  generatedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  runtimeScriptSha256=helpers.digest(runtime))
    for key, name in (('script', 'generate-optional-voice-previews.py'), ('helper', 'generate-male-voice-previews.py'),
                      ('adapter', 'speech-voice-adapter.py'), ('deviceRuntime', 'speech-device-runtime.py')):
        source, target = ROOT / 'scripts' / name, directory / name
        if target.exists() and target.read_bytes() != source.read_bytes():
            raise ValueError('Do not overwrite historical generation source; choose a new provenance directory')
        shutil.copyfile(source, target)
        result[key], result[key + 'Sha256'] = target.relative_to(ROOT).as_posix(), helpers.digest(target)
    return result


def verify_model(args, model):
    if model['id'].startswith('qwen3'):
        helpers.prepare_qwen(model, args.qwen_model, False)
        return
    if model['id'].startswith('zipvoice'):
        for item in model['files']:
            helpers.verify(args.zip_model / item['path'], item)
        return
    config = json.loads(args.f5_config.read_text(encoding='utf-8'))
    mapping = {'model_1250000.safetensors': config['model'], 'vocab.txt': config['vocabulary'],
               'vocos/config.yaml': config['vocoderConfig'], 'vocos/pytorch_model.bin': config['vocoderModel'],
               'reference.wav': config['referenceAudio'], 'reference.txt': config['referenceText']}
    for item in model['files']:
        if item['path'] in mapping:
            helpers.verify(args.f5_config.parent / mapping[item['path']], item)


def generate(args, voice, model, licenses):
    verify_model(args, model)
    generator = snapshot(voice, args.runtime_script)
    if voice.startswith('zipvoice_'):
        wav, elapsed, command = helpers.generate_zipvoice(args, voice)
    else:
        wav, elapsed, command = helpers.generate_python(args, voice, helpers.TEXT, voice)
    original = helpers.inspect_audio(wav)
    output = ASSETS / f'{voice}.mp3'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(wav), '-map_metadata', '-1',
                    '-c:a', 'libmp3lame', '-b:a', '128k', '-ar', '24000', '-ac', '1',
                    '-id3v2_version', '0', str(output)], check=True)
    decoded = helpers.inspect_audio(output)
    if abs(original['durationSeconds'] - decoded['durationSeconds']) > 1 / 24000:
        raise ValueError('The complete decoded audition must preserve generated audio duration')
    reference = None
    if not voice.startswith('qwen3_'):
        name = 'male-reference' if voice.endswith('_male') else 'zipvoice-reference' if voice.startswith('zipvoice_') else 'f5-reference'
        audio = ROOT / 'scripts/optional-speech-assets' / f'{name}.wav'
        text = audio.with_suffix('.txt')
        reference = dict(file=audio.relative_to(ROOT).as_posix(), sha256=helpers.digest(audio),
                         text=text.read_text(encoding='utf-8').strip(), synthetic=True)
    settings = dict(device='cpu', dtype='bfloat16' if voice.startswith('qwen3_') else 'float32',
                    speed=1, sampleRate=24000, channels=1, bitrate=128000,
                    threads=1 if voice.startswith('zipvoice_') else 4)
    if voice.startswith('zipvoice_'):
        settings.update(steps=8, featScale=.1, tShift=.5, targetRms=.1, guidanceScale=1, silenceScale=1)
    else:
        config_path = args.f5_config if voice.startswith('f5_') else args.qwen_model / 'runner-config.json'
        settings['config'] = json.loads(config_path.read_text(encoding='utf-8'))
        if voice == 'qwen3_uncle_fu':
            settings['config']['speaker'] = 'Uncle_Fu'
        elif voice == 'f5_zh_male':
            settings['config'].update(referenceAudio='job/male-reference.wav', referenceText='job/male-reference.txt')
    license_record = licenses[model['id']]
    record = dict(voiceId=voice, modelId=model['id'], language='zh-CN', file=output.name,
                  text=helpers.TEXT, bytes=output.stat().st_size, sha256=helpers.digest(output),
                  wavSha256=helpers.digest(wav), wav=str(wav), generationSeconds=elapsed, **original,
                  decodedDurationSeconds=decoded['durationSeconds'], decodedPeak=decoded['peak'], decodedRms=decoded['rms'],
                  modelFiles=[dict(path=item['path'], bytes=item['size'], sha256=item['sha256']) for item in model['files']],
                  referenceAudio=reference, settings=settings, generator=generator,
                  source=dict(kind='actual-model-synthesis', textId='open-media-introduction-20261018'),
                  license=license_record['license'], licenseFiles=license_record['licenseFiles'],
                  command=[str(value) for value in command])
    helpers.write_json(args.work / voice / 'record.json', record)
    print(f'PREVIEW READY: {voice}: {original["durationSeconds"]:.3f}s; synthesis {elapsed:.2f}s', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('python', 'qwen-model', 'f5-config', 'zip-model', 'runtime-script', 'speech-root', 'work'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--voices', nargs='+', choices=VOICES, default=list(VOICES))
    parser.add_argument('--assemble-only', action='store_true')
    args = parser.parse_args()
    for name in ('python', 'qwen_model', 'f5_config', 'zip_model', 'runtime_script', 'speech_root', 'work'):
        setattr(args, name, getattr(args, name).absolute())
    args.work.mkdir(parents=True, exist_ok=True)
    catalog = json.loads((ROOT / 'src-tauri/resources/speech-models.json').read_text(encoding='utf-8'))
    models = {item['id']: item for item in catalog['models']}
    historical = json.loads((ASSETS / 'provenance/pre-introduction-20261018/optional-manifest.json').read_text(encoding='utf-8'))
    licenses = {item['modelId']: item for item in historical['previews']}
    if not args.assemble_only:
        for voice in args.voices:
            generate(args, voice, models[MODELS[voice]], licenses)
        return
    records = [json.loads((args.work / voice / 'record.json').read_text(encoding='utf-8')) for voice in VOICES]
    for record in records:
        if record['text'] != helpers.TEXT or helpers.digest(ASSETS / record['file']) != record['sha256']:
            raise ValueError('Audition evidence does not describe the current text and audio')
    for name, selected in (('optional-manifest.json', records[:3]), ('male-manifest.json', records[3:])):
        helpers.write_json(ASSETS / name, dict(schema=3, text=helpers.TEXT,
            encoding='Actual model output encoded to MP3 once; no pitch, tempo, or loudness modification.', previews=selected))


if __name__ == '__main__':
    main()
