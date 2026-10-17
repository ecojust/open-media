#!/usr/bin/env python3
"""Validate real Chinese TTS runs and package an offline comparison page.

Only a completed build directory is a publishable artifact. This source directory
contains a template, not a benchmark result. No model or sample is synthesized here.
"""
from __future__ import annotations

import argparse
import array
import base64
import datetime as dt
import hashlib
import json
import math
import pathlib
import re
import shutil
import subprocess
import sys
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent
DEFAULT_CORPUS = ROOT / "corpus.json" if (ROOT / "corpus.json").is_file() else ROOT.parent / "corpus.json"


def read_json(path):
    return json.loads(pathlib.Path(path).read_text(encoding="utf-8"))


def write_json(path, value):
    pathlib.Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def sha256(path):
    digest = hashlib.sha256()
    with pathlib.Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def command(*args):
    result = subprocess.run(args, check=True, capture_output=True)
    return result.stdout


def probe(path):
    info = json.loads(command("ffprobe", "-v", "error", "-select_streams", "a:0", "-show_streams", "-show_format", "-of", "json", str(path)))
    if not info.get("streams"):
        raise ValueError(f"无可解码音轨：{path}")
    stream = info["streams"][0]
    duration = float(stream.get("duration") or info["format"]["duration"])
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError(f"音频时长无效：{path}")
    return {"duration_seconds": round(duration, 6), "sample_rate": int(stream["sample_rate"]), "channels": int(stream["channels"]), "codec": stream["codec_name"]}


def signal_stats(path):
    # Decode only for measurement. Original WAV bytes are copied unchanged.
    values = array.array("f", command("ffmpeg", "-v", "error", "-i", str(path), "-map", "0:a:0", "-f", "f32le", "-acodec", "pcm_f32le", "-"))
    if sys.byteorder != "little":
        values.byteswap()
    if not values or any(not math.isfinite(value) for value in values):
        raise ValueError(f"音频没有有效 PCM 样本：{path}")
    peak = max(abs(value) for value in values)
    rms = math.sqrt(sum(float(value) ** 2 for value in values) / len(values))
    if peak < 1e-6:
        raise ValueError(f"音频为全静音：{path}")
    return {"peak": round(peak, 8), "rms": round(rms, 8), "near_full_scale_samples": sum(abs(value) >= 0.999 for value in values), "over_full_scale_samples": sum(abs(value) > 1.0 for value in values), "decoded_samples": len(values)}


def positive_number(value, label, allow_zero=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0 or (not allow_zero and value == 0):
        raise ValueError(f"{label} 必须是真实{'非负' if allow_zero else '正'}数")
    return value


def source_file(manifest_path, value):
    path = pathlib.Path(value)
    return path.resolve() if path.is_absolute() else (manifest_path.parent / path).resolve()


def normalize(manifest_path, corpus):
    original = read_json(manifest_path)
    model = original.get("model", original)
    identity = model.get("id") or original.get("model_id")
    if not isinstance(identity, str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._-]{0,80}", identity):
        raise ValueError(f"{manifest_path}: 模型 id 仅允许字母、数字、点、下划线和短横线")
    name = model.get("name") or original.get("model_name")
    if not isinstance(name, str) or not name.strip():
        raise ValueError(f"{identity}: 缺少真实模型名称")
    total = positive_number(model.get("model_download_bytes", model.get("download_bytes")), f"{identity} 完整模型组件下载字节数")
    if int(total) != total:
        raise ValueError(f"{identity}: 下载字节数须为整数")
    weights = model.get("weights_bytes")
    if weights is not None:
        positive_number(weights, f"{identity} 权重字节数")
    unpacked = model.get("model_unpacked_bytes")
    if unpacked is not None:
        positive_number(unpacked, f"{identity} 必需解包组件字节数")
        if weights is not None and weights > unpacked:
            raise ValueError(f"{identity}: 权重大于必需解包组件体积")
    scope = model.get("download_scope") or model.get("size_notes")
    if not scope:
        raise ValueError(f"{identity}: 必须说明完整模型组件大小的计量范围，不能把权重称为完整安装体积")
    sources = model.get("sources", model.get("source", []))
    if isinstance(sources, (str, dict)):
        sources = [sources]
    if not sources:
        raise ValueError(f"{identity}: 缺少模型来源")
    license_name = model.get("license")
    if not license_name:
        raise ValueError(f"{identity}: 缺少模型许可信息")
    runtime = original.get("runtime", model.get("runtime", {}))
    hardware = original.get("hardware", model.get("hardware", {}))
    settings = original.get("settings", model.get("settings", {}))
    if not runtime or not hardware or not settings:
        raise ValueError(f"{identity}: 必须记录真实 runtime、hardware、settings")
    rss = original.get("peak_rss_bytes", model.get("peak_rss_bytes"))
    if rss is not None:
        positive_number(rss, f"{identity} 峰值进程内存")
    memory_notes = original.get("memory_notes", model.get("memory_notes", "未测量峰值内存；模型文件大小不代表运行内存。" if rss is None else "峰值进程常驻内存（RSS），不是模型下载大小。"))
    model_files = model.get("model_files", original.get("model_files", []))
    if model_files:
        file_total = 0
        for component in model_files:
            file_total += positive_number(component.get("bytes", component.get("size_bytes")), f"{identity} 模型组件大小", True)
        if unpacked is not None and file_total != unpacked:
            raise ValueError(f"{identity}: model_files 合计 {file_total} != model_unpacked_bytes {unpacked}")
    download_files = model.get("download_files", original.get("download_files", []))
    if download_files:
        download_total = sum(positive_number(component.get("bytes", component.get("size_bytes")), f"{identity} 下载文件大小", True) for component in download_files)
        if download_total != total:
            raise ValueError(f"{identity}: download_files 合计 {download_total} != model_download_bytes {total}")
    samples = original.get("samples", model.get("samples", []))
    if len(samples) != len(corpus):
        raise ValueError(f"{identity}: 必须包含全部 {len(corpus)} 条真实样本，目前 {len(samples)} 条")
    indexed = {}
    for sample in samples:
        sample_id = str(sample.get("id", "")).zfill(2)
        if sample_id in indexed:
            raise ValueError(f"{identity}: 样本 {sample_id} 重复")
        indexed[sample_id] = sample
    normalized_samples = []
    for row in corpus:
        sample = indexed.get(row["id"])
        if sample is None or sample.get("text") != row["text"]:
            raise ValueError(f"{identity}/{row['id']}: 原始中文语料不一致或缺失，不允许预先改写数字和多音词")
        path = source_file(manifest_path, sample.get("wav", sample.get("file", "")))
        if not path.is_file() or path.suffix.lower() != ".wav":
            raise ValueError(f"{identity}/{row['id']}: 原始 WAV 不存在：{path}")
        seconds = positive_number(sample.get("generation_seconds", sample.get("elapsed_seconds")), f"{identity}/{row['id']} 实际生成耗时", True)
        metadata = probe(path)
        declared_duration = sample.get("audio_seconds", sample.get("duration_seconds", sample.get("duration")))
        if declared_duration is not None and abs(float(declared_duration) - metadata["duration_seconds"]) > 0.15:
            raise ValueError(f"{identity}/{row['id']}: 实际音频时长与清单不一致")
        declared_hash = sample.get("wav_sha256", sample.get("sha256"))
        actual_hash = sha256(path)
        if declared_hash and declared_hash.lower() != actual_hash:
            raise ValueError(f"{identity}/{row['id']}: WAV SHA256 与清单不一致")
        normalized_text = sample.get("normalized_text", sample.get("inference_text", sample.get("processed_text")))
        if normalized_text is not None and (not isinstance(normalized_text, str) or not normalized_text.strip()):
            raise ValueError(f"{identity}/{row['id']}: 实际推理输入必须是非空字符串")
        normalized_samples.append({"id": row["id"], "text": row["text"], "normalized_text": normalized_text, "source_record": sample, "generation_seconds": seconds, "generation_notes": sample.get("generation_notes", original.get("generation_notes", "按原始生成清单记录；不同硬件或实现的耗时不能直接排名。")), "source_path": str(path), "wav_sha256": actual_hash, "wav_bytes": path.stat().st_size, **metadata, **signal_stats(path)})
    hashes = [sample["wav_sha256"] for sample in normalized_samples]
    if len(set(hashes)) != len(hashes):
        raise ValueError(f"{identity}: 不同原文对应了相同 WAV，请核对实际生成结果")
    runtime_bytes = model.get("runtime_download_bytes", runtime.get("runtime_download_bytes") if isinstance(runtime, dict) else None)
    if runtime_bytes is not None:
        positive_number(runtime_bytes, f"{identity} 运行库下载大小", True)
    return {"id": identity, "name": name, "model_family": model.get("model_family", model.get("family", name)), "voice": model.get("voice", original.get("voice", "以生成参数记录为准")), "model_download_bytes": int(total), "model_unpacked_bytes": unpacked, "weights_bytes": weights, "download_scope": scope, "runtime_download_bytes": runtime_bytes, "runtime_size_notes": model.get("runtime_size_notes", "运行库单独计量，未计入模型下载体积；此处不是软件安装包大小。"), "model_files": model_files, "download_files": download_files, "peak_rss_bytes": rss, "memory_notes": memory_notes, "runtime": runtime, "hardware": hardware, "settings": settings, "reference_audio": original.get("reference_audio", model.get("reference_audio")), "normalization": original.get("normalization", model.get("normalization")), "implementation_notes": original.get("implementation_notes", model.get("implementation_notes")), "diagnostic_group": original.get("diagnostic_group", model.get("diagnostic_group")), "sources": sources, "license": license_name, "notes": model.get("notes", original.get("notes", [])), "samples": normalized_samples, "source_manifest": str(manifest_path)}


def human_bytes(value):
    return f"{value / 1e9:.2f} GB" if value >= 1e9 else f"{value / 1e6:.1f} MB"


def readme(data, standalone, archive, raw_archive, raw_only=False):
    rows = []
    for model in data["models"]:
        duration = sum(sample["duration_seconds"] for sample in model["samples"])
        elapsed = sum(sample["generation_seconds"] for sample in model["samples"])
        memory = human_bytes(model["peak_rss_bytes"]) if model["peak_rss_bytes"] is not None else "未测量"
        safe_name = model["name"].replace("|", "\\|")
        rows.append(f"| {safe_name} | {human_bytes(model['model_download_bytes'])} | {memory} | {elapsed:.2f} 秒 | {duration:.2f} 秒 |")
    samples = "\n".join(f"| {row['id']} · {row['title']} | {row['text']} | {row['focus']} |" for row in data["corpus"])
    files = ["- [独立原始 WAV](wav/)：按模型分目录，每个模型 10 段；本包仅收录原始音频和记录，不含网页或 MP3。"] if raw_only else ["- [独立 MP3 音频](audio/) · [独立原始 WAV](wav/)：按模型分目录，每个模型 10 段，可直接查看或下载。", "- [本地试听页](index.html)：下载后打开，音频在 `audio/`。GitHub 文件预览不会运行网页。"]
    if standalone:
        files.append("- [单文件离线试听页](Open-Media-Chinese-TTS-Comparison.html)：下载 HTML 后直接打开，内含全部试听音频。")
    if archive:
        files.append("- [完整试听包](Open-Media-Chinese-TTS-Comparison.zip)：页面、MP3 试听、原始 WAV、语料、参数、清单与校验值；解压后打开 `index.html`。")
    if raw_archive:
        files.append("- [原始 WAV 包](Open-Media-Chinese-TTS-Raw-WAV.zip)：未增强、未变速的原始音频，供复核。")
    return f"""# 中文离线语音模型试听对比

使用完全相同的 10 段中文原文，对 **{len(data['models'])} 个模型、{len(data['models']) * len(data['corpus'])} 段真实合成结果**进行人工试听。资料整理时间：{data['created_at']}。

## 试听资料

{chr(10).join(files)}
- [数据清单](manifest.json)、[原始语料](corpus.json)、[校验报告](validation.json)、[SHA256 校验值](SHA256SUMS.txt)。
{'- [打包与验证脚本](scripts/README-BUILDER.md)：保留本次制作工具，可用原始生成清单重新打包。' if not raw_only else ''}
{'- 完整试听页面支持逐句横向对比、按模型浏览全部 10 条，以及隐藏模型信息的随机盲听；同时只播放一段音频。' if not raw_only else '- 本包的全部记录可直接用文本阅读器查看；试听页面在另行提供的完整试听包中。'}
- 原文始终保留。若使用模型官方中文前端规范化，实际推理输入、处理说明及样本复用来源会在清单中单独记录，并在完整试听页面的“本句输入与生成记录”中显示。

## 模型与实际记录

按全部必需模型文件的实际下载字节数递增排列；若通过压缩包分发，以整个下载包计量，解包后的必需组件体积另列。MB / GB 使用十进制，具体组成与字节数见清单。

| 模型 | 实际完整模型下载 | 峰值进程内存（RSS） | 10 条生成耗时合计 | 音频总时长 |
| --- | ---: | ---: | ---: | ---: |
{chr(10).join(rows)}

**模型下载量、解包组件大小、运行库体积、运行内存是不同指标。** 完整模型下载包含范围由每个模型单独注明，运行库默认未计入；这不是最终应用下载包大小。未测量的内存保持“未测量”。本批使用本地 2 CPU 配额环境及云端运行机器，部分本地推理共享 CPU；耗时来自实际记录，包含范围与硬件见详情，**不是同机独占速度排行，也不代表 Mac 真机速度**。模型质量使用同 10 段原文试听；固定音色或合成参考声音不同，均在参数中注明。

试听 MP3 仅从原始 WAV 编码，未调整音量、变速、降噪、裁剪停顿或替换内容。原始 WAV 字节原样保留并单独校验；浮点 WAV 如有超过满量程的样本，会保留原值并记录峰值和数量，不做归一化。MP3 是有损试听派生文件，精确波形请以原始 WAV 为准。页面固定 1 倍速和原始播放音量；不同模型本身的响度可能不同。

这是人工试听资料，没有编造自然度评分或排行榜结论。盲听会随机排列模型并隐藏名称、体积和性能信息，点击“显示模型”后恢复按体积排序。

## 统一语料

| 编号与题材 | 原文 | 关注点 |
| --- | --- | --- |
{samples}

## 记录与许可

各模型来源、许可、声音选择、推理参数、运行环境和原始生成清单保存在 `manifests/` 与 `manifest.json`。{'原始日志、参考音频、来源证据与诊断记录原样保存在 `provenance/`，复制前后均核对 SHA256；该目录包含诊断音频时，不计入正式对比的样本数。' if data.get('provenance') else ''} 模型名称用于识别实际测试对象，不表示软件已经内置这些模型。样本只代表对应声音与本次参数，其他声音或参数可能得到不同结果。使用已有音频的样本会保留真实复用记录与原次生成耗时，不将复制时间伪装为重新合成时间。
"""


def zip_files(path, root, paths, prefix, content_overrides=None):
    paths = [file for file in paths if file.relative_to(root).as_posix() != "SHA256SUMS.txt"]
    content_overrides = content_overrides or {}
    checksums = []
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for file in sorted(paths):
            relative = file.relative_to(root).as_posix()
            if relative in content_overrides:
                content = content_overrides[relative]
                archive.writestr(f"{prefix}/{relative}", content)
                digest = hashlib.sha256(content).hexdigest()
            else:
                archive.write(file, f"{prefix}/{relative}")
                digest = sha256(file)
            checksums.append(f"{digest}  {relative}\n")
        archive.writestr(f"{prefix}/SHA256SUMS.txt", "".join(checksums))
    with zipfile.ZipFile(path) as archive:
        bad = archive.testzip()
        if bad:
            raise ValueError(f"ZIP 校验失败：{bad}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", action="append", required=True, help="每个模型的真实生成清单，可重复传入")
    parser.add_argument("--corpus", type=pathlib.Path, default=DEFAULT_CORPUS)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    parser.add_argument("--minimum-models", type=int, default=3)
    parser.add_argument("--standalone", action="store_true", help="生成内含 MP3 的单文件离线 HTML")
    parser.add_argument("--zip", action="store_true", dest="make_zip", help="生成网页、试听 MP3 与原始 WAV 的完整 ZIP")
    parser.add_argument("--raw-zip", action="store_true", help="生成原始 WAV 和完整元数据的独立 ZIP")
    parser.add_argument("--provenance-dir", type=pathlib.Path, help="整理后的原始记录、日志、参考音频与来源证据目录，原样递归复制；不应包含模型权重")
    parser.add_argument("--overwrite", action="store_true", help="仅允许覆盖含本工具标记的输出目录")
    args = parser.parse_args()
    corpus = read_json(args.corpus)
    if len(corpus) != 10 or [row["id"] for row in corpus] != [f"{value:02d}" for value in range(1, 11)]:
        raise ValueError("统一语料必须是编号 01—10 的 10 条中文原文")
    manifests = [pathlib.Path(value).resolve() for value in args.manifest]
    models = [normalize(path, corpus) for path in manifests]
    if len(models) < args.minimum_models or len({model["id"] for model in models}) != len(models):
        raise ValueError(f"至少需要 {args.minimum_models} 个不同 id 的真实模型")
    models.sort(key=lambda model: (model["model_download_bytes"], model["id"]))
    output = args.output.resolve()
    provenance_source = args.provenance_dir.resolve() if args.provenance_dir else None
    if provenance_source is not None:
        if not provenance_source.is_dir():
            raise ValueError(f"原始证据目录不存在：{provenance_source}")
        if provenance_source == output or provenance_source in output.parents or output in provenance_source.parents:
            raise ValueError("原始证据与输出目录不能互相包含，以免重复复制或覆盖源文件")
    marker = output / ".tts-comparison-output"
    if output.exists() and any(output.iterdir()):
        if not args.overwrite or not marker.is_file() or output == ROOT or output in ROOT.parents:
            raise ValueError("输出目录非空；仅带 .tts-comparison-output 标记的旧生成目录可通过 --overwrite 替换")
        shutil.rmtree(output)
    output.mkdir(parents=True, exist_ok=True)
    marker.write_text("generated by package.py\n")
    for folder in ["audio", "wav", "manifests", "licenses"]:
        (output / folder).mkdir()
    for model in models:
        identity = model["id"]
        (output / "audio" / identity).mkdir()
        (output / "wav" / identity).mkdir()
        source_manifest = pathlib.Path(model.pop("source_manifest"))
        shutil.copyfile(source_manifest, output / "manifests" / f"{identity}.json")
        source_licenses = source_manifest.parent / "licenses"
        if source_licenses.is_dir():
            target_licenses = output / "licenses" / identity
            shutil.copytree(source_licenses, target_licenses)
            model["license_files"] = [file.relative_to(output).as_posix() for file in sorted(target_licenses.rglob("*")) if file.is_file()]
        for sample in model["samples"]:
            original = pathlib.Path(sample.pop("source_path"))
            wav = output / "wav" / identity / f"{sample['id']}.wav"
            mp3 = output / "audio" / identity / f"{sample['id']}.mp3"
            shutil.copyfile(original, wav)
            if sha256(wav) != sample["wav_sha256"]:
                raise ValueError(f"原始 WAV 复制校验失败：{wav}")
            command("ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(wav), "-map", "0:a:0", "-map_metadata", "-1", "-vn", "-c:a", "libmp3lame", "-b:a", "192k", str(mp3))
            mp3_info = probe(mp3)
            if abs(mp3_info["duration_seconds"] - sample["duration_seconds"]) > 0.2:
                raise ValueError(f"试听编码时长异常：{mp3}")
            sample.update({"wav": wav.relative_to(output).as_posix(), "mp3": mp3.relative_to(output).as_posix(), "mp3_bytes": mp3.stat().st_size, "mp3_sha256": sha256(mp3), "mp3_duration_seconds": mp3_info["duration_seconds"]})
        audio_rows = [f"| {row['id']} · {row['title']} | [MP3]({row['id']}.mp3) | [WAV](../../wav/{identity}/{row['id']}.wav) | {row['text']} |" for row in corpus]
        (output / "audio" / identity / "README.md").write_text(
            f"# {model['name']}\n\n10 段独立试听文件，全部使用统一中文原文。\n\n"
            "| 语料 | 试听 | 原始音频 | 文本 |\n| --- | --- | --- | --- |\n"
            + "\n".join(audio_rows) + "\n\n[完整参数与来源](../../README.md)\n", encoding="utf-8")
    provenance_files = []
    if provenance_source is not None:
        provenance_target = output / "provenance"
        shutil.copytree(provenance_source, provenance_target)
        for source in sorted(provenance_source.rglob("*")):
            if not source.is_file():
                continue
            target = provenance_target / source.relative_to(provenance_source)
            digest = sha256(source)
            if not target.is_file() or sha256(target) != digest:
                raise ValueError(f"原始证据复制校验失败：{source}")
            provenance_files.append({"path": target.relative_to(output).as_posix(), "bytes": target.stat().st_size, "sha256": digest})
        write_json(output / "provenance-index.json", {"files": provenance_files, "bytes": sum(file["bytes"] for file in provenance_files), "copy_verification": "每个原始文件与复制后的文件 SHA256 一致。"})
    data = {"schema": 1, "title": "中文离线语音试听对比", "created_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "measurement": {"byte_units": "decimal", "sort": "model_download_bytes ascending", "audio_processing": "原始 WAV 未修改；MP3 仅编码，不增强、变速、降噪或裁剪。", "text_processing": "保留统一原文；模型官方前端规范化产生的实际输入另记 normalized_text，不替换原文。复用音频保留来源与原次生成耗时。", "runtime_size": "运行库体积默认未计，逐模型记录；模型组件大小不是最终应用安装包大小。", "quality_scores": "未提供人工或自动自然度评分。"}, "corpus": corpus, "models": models, "provenance": {"files": len(provenance_files), "bytes": sum(file["bytes"] for file in provenance_files)} if provenance_source is not None else None}
    write_json(output / "manifest.json", data)
    write_json(output / "corpus.json", corpus)
    scripts = output / "scripts"
    scripts.mkdir()
    for name in ["package.py", "template.html", "verify-browser.cjs", "README-BUILDER.md"]:
        shutil.copyfile(ROOT / name, scripts / name)
    template = (ROOT / "template.html").read_text(encoding="utf-8")
    if template.count("/*__COMPARISON_DATA__*/ null") != 1:
        raise ValueError("页面模板数据标记无效")
    def html(payload):
        return template.replace("/*__COMPARISON_DATA__*/ null", json.dumps(payload, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029"))
    (output / "index.html").write_text(html(data), encoding="utf-8")
    if args.standalone:
        embedded = json.loads(json.dumps(data))
        for model in embedded["models"]:
            for sample in model["samples"]:
                sample["mp3"] = "data:audio/mpeg;base64," + base64.b64encode((output / sample["mp3"]).read_bytes()).decode()
        embedded["standalone"] = True
        (output / "Open-Media-Chinese-TTS-Comparison.html").write_text(html(embedded), encoding="utf-8")
    report = {"models": len(models), "samples_per_model": len(corpus), "samples": sum(len(model["samples"]) for model in models), "unique_wav_hashes": len({sample["wav_sha256"] for model in models for sample in model["samples"]}), "wav_bytes": sum(sample["wav_bytes"] for model in models for sample in model["samples"]), "mp3_bytes": sum(sample["mp3_bytes"] for model in models for sample in model["samples"]), "audio_seconds": round(sum(sample["duration_seconds"] for model in models for sample in model["samples"]), 3), "near_full_scale_samples": sum(sample["near_full_scale_samples"] for model in models for sample in model["samples"]), "over_full_scale_samples": sum(sample["over_full_scale_samples"] for model in models for sample in model["samples"]), "provenance_files": len(provenance_files), "provenance_bytes": sum(file["bytes"] for file in provenance_files), "validation": ["10 条原文逐字一致，前端规范化输入另列", "全部原始 WAV 实际解码并测量时长、采样率、峰值与 RMS", "原始 WAV 复制前后 SHA256 一致", "全部 MP3 实际解码并核对时长", "完整模型组件按实际字节数排序", "缺失耗时、来源、许可或大小计量范围时拒绝打包"] + (["原始记录、日志与参考证据递归复制前后 SHA256 一致"] if provenance_source is not None else [])}
    write_json(output / "validation.json", report)
    (output / "README.md").write_text(readme(data, args.standalone, args.make_zip, args.raw_zip), encoding="utf-8")
    files = [path for path in output.rglob("*") if path.is_file() and path != marker]
    checksum = output / "SHA256SUMS.txt"
    checksum.write_text("".join(f"{sha256(path)}  {path.relative_to(output).as_posix()}\n" for path in sorted(files)), encoding="utf-8")
    files.append(checksum)
    if args.make_zip:
        zip_files(output / "Open-Media-Chinese-TTS-Comparison.zip", output, [file for file in files if file.relative_to(output).as_posix() != "Open-Media-Chinese-TTS-Comparison.html"], "Open-Media-Chinese-TTS-Comparison", {"README.md": readme(data, False, False, False).encode("utf-8")})
    if args.raw_zip:
        zip_files(output / "Open-Media-Chinese-TTS-Raw-WAV.zip", output, [file for file in files if file.relative_to(output).parts[0] in {"wav", "manifests", "licenses", "provenance"} or (file.parent == output and file.name in {"manifest.json", "corpus.json", "validation.json", "provenance-index.json", "SHA256SUMS.txt", "README.md"})], "Open-Media-Chinese-TTS-Raw-WAV", {"README.md": readme(data, False, False, False, raw_only=True).encode("utf-8")})
    archive_files = sorted(output.glob("*.zip"))
    if archive_files:
        (output / "ARCHIVE-SHA256SUMS.txt").write_text("".join(f"{sha256(path)}  {path.name}\n" for path in archive_files), encoding="utf-8")
    print(json.dumps({"output": str(output), **report, "archives": [{"name": path.name, "bytes": path.stat().st_size, "sha256": sha256(path)} for path in archive_files]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, TypeError, subprocess.CalledProcessError) as error:
        print(f"打包失败：{error}", file=sys.stderr)
        sys.exit(1)
