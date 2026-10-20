use crate::{
    asset_tools::{encode_base64, run_process, TaskControl, MEDIA_FORMATS},
    engine::{process, MediaStore, Result, Runtime},
};
use serde_json::{json, Value};
use std::path::Path;

#[path = "asset_tools_repetition.rs"]
mod repetition;

const MAX_PROBE_BYTES: usize = 1024 * 1024;
const MAX_FRAME_BYTES: usize = 2 * 1024 * 1024;
const MAX_STORYBOARD_BYTES: usize = 8 * 1024 * 1024;
const MAX_ANALYSIS_BYTES: usize = 4 * 1024 * 1024;
const MAX_INTERVALS: usize = 4096;

fn number(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str()?.parse().ok())
        .filter(|value| value.is_finite())
}

fn read_probe(runtime: &Runtime, path: &Path, control: &TaskControl) -> Result<Value> {
    let mut command = process(&runtime.probe);
    command
        .args([
            "-v",
            "error",
            "-protocol_whitelist",
            "file,pipe",
            "-format_whitelist",
            MEDIA_FORMATS,
            "-show_format",
            "-show_streams",
            "-of",
            "json",
        ])
        .arg(path);
    let output = run_process(command, control, MAX_PROBE_BYTES)?;
    let value: Value =
        serde_json::from_slice(&output.stdout).map_err(|_| "媒体信息不是有效的 JSON。")?;
    let streams = value["streams"]
        .as_array()
        .ok_or("素材没有可读取的媒体流。")?;
    if streams.is_empty() || streams.len() > 64 {
        return Err("媒体流数量不在允许范围内。".into());
    }
    Ok(value)
}

fn streams(value: &Value) -> &[Value] {
    value["streams"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
}

fn video_stream(value: &Value) -> Option<&Value> {
    streams(value).iter().find(|stream| {
        stream["codec_type"] == "video" && stream["disposition"]["attached_pic"] != 1
    })
}

fn audio_stream(value: &Value) -> Option<&Value> {
    streams(value)
        .iter()
        .find(|stream| stream["codec_type"] == "audio")
}

fn duration(value: &Value) -> Option<f64> {
    number(&value["format"]["duration"])
        .or_else(|| {
            streams(value)
                .iter()
                .filter_map(|s| {
                    number(&s["duration"]).or_else(|| {
                        let parts = s["tags"]["DURATION"]
                            .as_str()?
                            .split(':')
                            .map(str::parse::<f64>)
                            .collect::<std::result::Result<Vec<_>, _>>()
                            .ok()?;
                        (parts.len() == 3).then(|| parts[0] * 3600.0 + parts[1] * 60.0 + parts[2])
                    })
                })
                .reduce(f64::max)
        })
        .filter(|value| value.is_finite() && *value > 0.0)
}

fn import_duration(kind: &str, info: &Value) -> Option<f64> {
    let reported = duration(info);
    if kind == "image" {
        // Still-image demuxers may report no duration or one synthetic frame.
        // Match the editor's minimum image clip length, preserving longer animations.
        Some(reported.unwrap_or(5.0).max(5.0))
    } else {
        reported
    }
}

fn frame_rate(stream: &Value) -> Option<f64> {
    ["avg_frame_rate", "r_frame_rate"].iter().find_map(|key| {
        let rate = stream[*key].as_str()?;
        let (a, b) = rate.split_once('/')?;
        let rate = a.parse::<f64>().ok()? / b.parse::<f64>().ok()?;
        (rate.is_finite() && rate > 0.0).then_some(rate)
    })
}

fn stream_summary(stream: &Value) -> Value {
    json!({
        "index": stream["index"],
        "type": stream["codec_type"],
        "codec": stream["codec_name"],
        "profile": stream["profile"],
        "duration": number(&stream["duration"]),
        "startTime": number(&stream["start_time"]),
        "timeBase": stream["time_base"],
        "bitRate": number(&stream["bit_rate"]),
        "width": stream["width"],
        "height": stream["height"],
        "pixelFormat": stream["pix_fmt"],
        "frameRate": frame_rate(stream),
        "rotationDegrees": stream_rotation(stream),
        "hasAlphaChannel": alpha_channel(stream),
        "sampleRate": number(&stream["sample_rate"]),
        "channels": stream["channels"],
        "channelLayout": stream["channel_layout"],
        "attachedPicture": stream["disposition"]["attached_pic"] == 1,
    })
}

fn stream_rotation(stream: &Value) -> f64 {
    stream["side_data_list"]
        .as_array()
        .and_then(|items| items.iter().find_map(|item| number(&item["rotation"])))
        .or_else(|| number(&stream["tags"]["rotate"]))
        .unwrap_or(0.)
        .rem_euclid(360.)
}
fn alpha_channel(stream: &Value) -> Option<bool> {
    if stream["codec_type"] != "video" {
        return None;
    }
    if stream["tags"]["alpha_mode"] == "1" || stream["tags"]["alpha_mode"] == 1 {
        return Some(true);
    }
    let format = stream["pix_fmt"].as_str()?;
    // Palette transparency cannot be established solely from stream metadata.
    if format == "pal8" {
        return None;
    }
    Some(
        ["rgba", "bgra", "argb", "abgr", "yuva", "gbrap", "ya"]
            .iter()
            .any(|prefix| format.starts_with(prefix)),
    )
}

/// Internal import helper; callers must first authorize the local path or create it in the media store.
pub fn probe_file(
    runtime: &Runtime,
    path: &Path,
    name: &str,
    control: &TaskControl,
) -> Result<Value> {
    control.check()?;
    let info = read_probe(runtime, path, control)?;
    let video = video_stream(&info);
    let audio = audio_stream(&info);
    let extension = Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let is_image = [
        "png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff", "avif", "heic", "heif", "gif", "ico",
    ]
    .contains(&extension.as_str());
    let kind = if video.is_some() {
        if is_image {
            "image"
        } else {
            "video"
        }
    } else if audio.is_some() {
        "audio"
    } else {
        return Err("文件不包含支持的媒体内容。".into());
    };
    let mut width = video
        .and_then(|stream| stream["width"].as_u64())
        .unwrap_or_default();
    let mut height = video
        .and_then(|stream| stream["height"].as_u64())
        .unwrap_or_default();
    if let Some(video) = video {
        let rotation = video["side_data_list"]
            .as_array()
            .and_then(|list| list.iter().find_map(|item| number(&item["rotation"])))
            .or_else(|| number(&video["tags"]["rotate"]))
            .unwrap_or(0.0)
            .rem_euclid(360.0);
        if (rotation - 90.0).abs() < 0.01 || (rotation - 270.0).abs() < 0.01 {
            std::mem::swap(&mut width, &mut height);
        }
    }
    let mime = match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "tif" | "tiff" => "image/tiff",
        "avif" => "image/avif",
        "heic" | "heif" => "image/heif",
        "ico" => "image/x-icon",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "aac" => "audio/aac",
        "flac" => "audio/flac",
        "m4a" => "audio/mp4",
        "ogg" | "opus" if kind == "audio" => "audio/ogg",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
        _ if kind == "video" => "video/mp4",
        _ => "application/octet-stream",
    };
    let media_duration = match import_duration(kind, &info) {
        Some(duration) => duration,
        None => packet_duration(runtime, path, control)?,
    };
    Ok(json!({
        "kind": kind, "mime": mime, "width": width, "height": height,
        "format": info["format"]["format_name"],
        "duration": media_duration,
        "sourceDuration": duration(&info),
        "startTime": number(&info["format"]["start_time"]),
        "size": std::fs::metadata(path).map_err(|_| "无法读取素材文件信息。")?.len(),
        "bitRate": number(&info["format"]["bit_rate"]),
        "hasVideo": video_stream(&info).is_some(),
        "hasAudio": audio_stream(&info).is_some(),
        "frameRate": video.and_then(frame_rate),
        "rotationDegrees": video.map(stream_rotation),
        "hasAlphaChannel": video.and_then(alpha_channel),
        "streams": streams(&info).iter().map(stream_summary).collect::<Vec<_>>(),
    }))
}

fn packet_duration(runtime: &Runtime, path: &Path, control: &TaskControl) -> Result<f64> {
    let mut command = process(&runtime.probe);
    command
        .args([
            "-v",
            "error",
            "-protocol_whitelist",
            "file,pipe",
            "-format_whitelist",
            MEDIA_FORMATS,
            "-show_entries",
            "packet=pts_time,dts_time,duration_time",
            "-of",
            "compact=p=0:nk=0",
        ])
        .arg(path);
    let output = run_process(command, control, MAX_ANALYSIS_BYTES)?;
    let text = std::str::from_utf8(&output.stdout).map_err(|_| "媒体时间戳输出无效。")?;
    let mut first = f64::INFINITY;
    let mut last = f64::NEG_INFINITY;
    for line in text.lines() {
        let timestamp = field_number(line, "pts_time=").or_else(|| field_number(line, "dts_time="));
        if let Some(timestamp) = timestamp {
            let duration = field_number(line, "duration_time=").unwrap_or(0.0).max(0.0);
            first = first.min(timestamp);
            last = last.max(timestamp + duration);
        }
    }
    let duration = last - first;
    if !duration.is_finite() || duration <= 0.0 {
        return Err("无法确定媒体时长，请检查文件是否完整。".into());
    }
    Ok(duration)
}

pub fn probe(
    store: &MediaStore,
    runtime: &Runtime,
    asset: &Value,
    control: &TaskControl,
) -> Result<Value> {
    control.check()?;
    let path = store.authorized_path(asset)?;
    let name = asset["name"]
        .as_str()
        .or_else(|| path.file_name().and_then(|name| name.to_str()))
        .unwrap_or_default();
    let mut result = probe_file(runtime, &path, name, control)?;
    result["assetId"] = asset["id"].clone();
    Ok(result)
}

fn validate_frame(time: f64, max_width: u32) -> Result<()> {
    if !time.is_finite() || time < 0.0 {
        return Err("取帧时间必须是非负有限秒数。".into());
    }
    if !(1..=1920).contains(&max_width) {
        return Err("取帧最大宽度需要在 1–1920 像素之间。".into());
    }
    Ok(())
}

fn png_size(bytes: &[u8]) -> Result<(u32, u32)> {
    if bytes.len() < 24 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" || &bytes[12..16] != b"IHDR" {
        return Err("未能获取有效的 PNG 图像帧。".into());
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    if width == 0 || height == 0 {
        return Err("图像帧尺寸无效。".into());
    }
    Ok((width, height))
}

fn field_number(line: &str, key: &str) -> Option<f64> {
    let remainder = line.split_once(key)?.1.trim_start();
    remainder
        .split(|character: char| character.is_whitespace() || character == '|')
        .next()?
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
}

fn read_frame(
    runtime: &Runtime,
    path: &Path,
    info: &Value,
    time: f64,
    max_width: u32,
    control: &TaskControl,
) -> Result<Value> {
    control.check()?;
    validate_frame(time, max_width)?;
    let video = video_stream(info).ok_or("该素材没有可提取画面的有效视频流。")?;
    if duration(info).is_some_and(|duration| time >= duration) {
        return Err("取帧时间超出素材时长。".into());
    }
    let mut command = process(&runtime.encoder);
    command
        .args(["-hide_banner", "-nostdin", "-loglevel", "info", "-protocol_whitelist", "file,pipe", "-format_whitelist", MEDIA_FORMATS, "-ss"])
        .arg(format!("{time:.9}"))
        .arg("-i")
        .arg(path)
        .arg("-map")
        .arg(format!("0:{}", video["index"].as_u64().ok_or("视频流索引无效。")?))
        .args(["-an", "-sn", "-dn", "-vf"])
        .arg(format!(
            "scale=w='min(iw,{max_width})':h='min(ih,1920)':force_original_aspect_ratio=decrease,setsar=1,showinfo"
        ))
        .args(["-frames:v", "1", "-threads", "1", "-c:v", "png", "-f", "image2pipe", "pipe:1"]);
    let output = run_process(command, control, MAX_FRAME_BYTES)?;
    let (width, height) = png_size(&output.stdout)?;
    let base64 = encode_base64(&output.stdout);
    if base64.len() > MAX_FRAME_BYTES {
        return Err("图像帧超过 2 MiB，请降低最大宽度。".into());
    }
    let frame_offset = output
        .stderr
        .lines()
        .find(|line| line.contains("showinfo") && line.contains("pts_time:"))
        .and_then(|line| field_number(line, "pts_time:"));
    Ok(json!({
        "requestedTime": time,
        "sourceTime": frame_offset.map(|offset| (time + offset).max(0.0)),
        "timeBase": "assetSeconds",
        "mimeType": "image/png",
        "width": width,
        "height": height,
        "base64": base64,
        "encodedBytes": base64.len(),
    }))
}

pub fn frame(
    store: &MediaStore,
    runtime: &Runtime,
    asset: &Value,
    time: f64,
    max_width: u32,
    control: &TaskControl,
) -> Result<Value> {
    control.check()?;
    validate_frame(time, max_width)?;
    let path = store.authorized_path(asset)?;
    let info = read_probe(runtime, &path, control)?;
    let mut result = read_frame(runtime, &path, &info, time, max_width, control)?;
    result["assetId"] = asset["id"].clone();
    Ok(result)
}

pub fn storyboard(
    store: &MediaStore,
    runtime: &Runtime,
    asset: &Value,
    start: f64,
    end: Option<f64>,
    count: u32,
    max_width: u32,
    control: &TaskControl,
) -> Result<Value> {
    storyboard_with_options(
        store, runtime, asset, start, end, count, max_width, "time", 0.3, control,
    )
}

pub fn storyboard_with_options(
    store: &MediaStore,
    runtime: &Runtime,
    asset: &Value,
    start: f64,
    end: Option<f64>,
    count: u32,
    max_width: u32,
    mode: &str,
    threshold: f64,
    control: &TaskControl,
) -> Result<Value> {
    control.check()?;
    validate_frame(start, max_width)?;
    if !(1..=24).contains(&count) {
        return Err("分镜帧数需要在 1–24 之间。".into());
    }
    if !matches!(mode, "time" | "scene") {
        return Err("分镜模式需要为 time 或 scene。".into());
    }
    if !threshold.is_finite() || !(0.0..=1.0).contains(&threshold) {
        return Err("场景阈值需要在 0–1 之间。".into());
    }
    let path = store.authorized_path(asset)?;
    let info = read_probe(runtime, &path, control)?;
    let video = video_stream(&info).ok_or("该素材没有可提取分镜的视频流。")?;
    let duration = duration(&info).ok_or("分镜需要具有明确时长的视频素材。")?;
    let end = end.unwrap_or(duration);
    if !end.is_finite() || end <= start || end > duration || start >= duration {
        return Err("分镜起止时间必须位于素材时长内，且结束时间大于开始时间。".into());
    }
    if mode == "scene" && end - start > 600.0 {
        return Err("场景分镜单次最多分析 600 秒，请缩小起止时间范围。".into());
    }
    let frame_step = 1.0 / frame_rate(video).unwrap_or(25.0);
    let last = (end - frame_step).max(start);
    let mut scene_intervals: Vec<(f64, f64, Option<Value>)> = Vec::new();
    if mode == "scene" {
        let points = scan_scene_points(
            runtime,
            &path,
            &info,
            start,
            Some(end),
            threshold,
            frame_step.max(0.1),
            control,
        )?;
        let mut boundary = start;
        let mut evidence = None;
        for point in points {
            let at = point["time"].as_f64().ok_or("场景时间无效。")?;
            if at <= start + 1e-6 || at >= end {
                continue;
            }
            scene_intervals.push((boundary, at, evidence.take()));
            boundary = at;
            evidence = Some(point);
        }
        scene_intervals.push((boundary, end, evidence));
    }
    let number = if mode == "scene" {
        (count as usize).min(scene_intervals.len())
    } else {
        count as usize
    };
    let mut total_bytes = 0;
    let mut frames = Vec::with_capacity(number);
    for index in 0..number {
        control.check()?;
        let scene_index = if number <= 1 {
            0
        } else {
            index * scene_intervals.len().saturating_sub(1) / (number - 1)
        };
        let time = if mode == "scene" {
            let (a, b, _) = &scene_intervals[scene_index];
            // Stay inside short scenes rather than seeking just beyond their last frame.
            (a + (b - a) / 2.0).min((b - frame_step).max(*a))
        } else if number == 1 {
            start
        } else {
            start + (last - start) * index as f64 / (number - 1) as f64
        };
        let mut image = read_frame(runtime, &path, &info, time, max_width, control)?;
        if mode == "scene" {
            let (a, b, evidence) = &scene_intervals[scene_index];
            image["sceneStart"] = json!(a);
            image["sceneEnd"] = json!(b);
            image["sceneIndex"] = json!(scene_index);
            image["sceneEvidence"] = evidence
                .clone()
                .unwrap_or_else(|| json!({"kind":"range_start","time":start}));
        }
        total_bytes += image["base64"].as_str().map(str::len).unwrap_or_default();
        if total_bytes > MAX_STORYBOARD_BYTES {
            return Err("分镜图像总量超过 8 MiB，请减少帧数或最大宽度。".into());
        }
        frames.push(image);
    }
    Ok(
        json!({"assetId":asset["id"],"start":start,"end":end,"mode":mode,"frames":frames,"encodedBytes":total_bytes,
        "sceneCount":if mode=="scene"{Some(scene_intervals.len())}else{None},"truncated":mode=="scene"&&scene_intervals.len()>count as usize,
        "sceneDetection":if mode=="scene" { Some(json!({"threshold":threshold,"minInterval":frame_step.max(0.1),"maxAnalysisSeconds":600,"selection":"scene_midpoints","interpretation":"基于画面差异阈值的场景候选，不表示语义场景识别；超过帧数上限时按场景顺序均匀选取。"})) } else {None} }),
    )
}

fn scene_points(text: &str, threshold: f64, min_interval: f64) -> Vec<Value> {
    let mut time = None;
    let mut points: Vec<Value> = Vec::new();
    for line in text.lines() {
        if line.starts_with("frame:") {
            time = field_number(line, "pts_time:");
        } else if let Some(score) = field_number(line, "lavfi.scene_score=") {
            if let Some(at) = time.take().filter(|time| *time >= 0.0) {
                if score <= threshold {
                    continue;
                }
                let point = json!({
                    "time": at,
                    "score": score,
                    "confidence": score.clamp(0.0, 1.0),
                    "evidence": { "detector": "scene_difference", "score": score, "threshold": threshold },
                });
                if let Some(previous) = points
                    .last_mut()
                    .filter(|p| at - p["time"].as_f64().unwrap_or(0.0) < min_interval)
                {
                    if score > previous["score"].as_f64().unwrap_or(0.0) {
                        *previous = point;
                    }
                } else {
                    points.push(point);
                }
            }
        }
    }
    points
}

fn scan_scene_points(
    runtime: &Runtime,
    path: &Path,
    info: &Value,
    start: f64,
    end: Option<f64>,
    threshold: f64,
    min_interval: f64,
    control: &TaskControl,
) -> Result<Vec<Value>> {
    let video = video_stream(info).ok_or("场景切换检测需要视频素材。")?;
    let mut command = process(&runtime.encoder);
    command.args([
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-format_whitelist",
        MEDIA_FORMATS,
    ]);
    if start > 0.0 {
        command.arg("-ss").arg(format!("{start:.9}"));
    }
    if let Some(end) = end {
        command.arg("-t").arg((end - start).to_string());
    }
    command.arg("-i").arg(path).arg("-map").arg(format!(
        "0:{}",
        video["index"].as_u64().ok_or("视频流索引无效。")?
    ));
    command.args(["-an", "-sn", "-dn", "-vf"]).arg(format!("scale=w='min(iw,640)':h='min(ih,640)':force_original_aspect_ratio=decrease,select='gt(scene,{threshold:.8})',metadata=print:file=-"));
    command.args(["-threads", "1", "-f", "null", "-"]);
    let output = run_process(command, control, MAX_ANALYSIS_BYTES)?;
    let text = std::str::from_utf8(&output.stdout).map_err(|_| "场景检测输出无效。")?;
    let mut points = scene_points(text, threshold, min_interval);
    for point in &mut points {
        point["time"] = json!(point["time"].as_f64().unwrap_or(0.) + start);
    }
    points.retain(|p| {
        p["time"]
            .as_f64()
            .is_some_and(|time| time >= start && end.is_none_or(|end| time < end))
    });
    if points.len() > MAX_INTERVALS {
        return Err("检测到的场景切换超过 4096 个，请提高阈值或最小间隔。".into());
    }
    Ok(points)
}

pub fn detect_scenes(
    store: &MediaStore,
    runtime: &Runtime,
    asset: &Value,
    threshold: f64,
    min_interval: f64,
    control: &TaskControl,
) -> Result<Value> {
    control.check()?;
    if !threshold.is_finite()
        || !(0.0..=1.0).contains(&threshold)
        || !min_interval.is_finite()
        || !(0.0..=3600.0).contains(&min_interval)
    {
        return Err("场景阈值需要在 0–1 之间，最小间隔需要在 0–3600 秒之间。".into());
    }
    let path = store.authorized_path(asset)?;
    let info = read_probe(runtime, &path, control)?;
    let points = scan_scene_points(
        runtime,
        &path,
        &info,
        0.0,
        None,
        threshold,
        min_interval,
        control,
    )?;
    Ok(json!({
        "assetId": asset["id"], "duration": duration(&info), "timeBase": "assetSeconds",
        "threshold": threshold, "minInterval": min_interval, "points": points,
        "interpretation": "画面差异阈值检测，置信度表示归一化画面差异，不代表语义场景识别。",
    }))
}

fn interval(
    kind: &str,
    start: f64,
    end: f64,
    duration: f64,
    minimum: f64,
    noise_db: f64,
) -> Option<Value> {
    let start = start.max(0.0).min(duration);
    let end = end.max(start).min(duration);
    if end - start + 0.001 < minimum {
        return None;
    }
    let evidence = match kind {
        "black" => {
            json!({ "detector": "blackdetect", "minimumDuration": minimum, "pixelThreshold": 0.10, "pictureBlackRatio": 0.98 })
        }
        "freeze" => {
            json!({ "detector": "freezedetect", "minimumDuration": minimum, "differenceNoiseDb": -60.0 })
        }
        _ => {
            json!({ "detector": "silencedetect", "minimumDuration": minimum, "noiseDb": noise_db })
        }
    };
    Some(
        json!({ "kind": kind, "start": start, "end": end, "duration": end - start, "confidence": 1.0, "confidenceBasis": "detector_threshold_matched", "evidence": evidence }),
    )
}

fn idle_intervals(text: &str, duration: f64, minimum: f64, noise_db: f64) -> Vec<Value> {
    let mut intervals = Vec::new();
    let mut freeze_start = None;
    let mut silence_start = None;
    for line in text.lines() {
        if line.contains("blackdetect") {
            if let (Some(start), Some(end)) = (
                field_number(line, "black_start:"),
                field_number(line, "black_end:"),
            ) {
                intervals.extend(interval("black", start, end, duration, minimum, noise_db));
            }
        }
        if line.contains("freezedetect") {
            if let Some(start) = field_number(line, "freeze_start:") {
                freeze_start = Some(start);
            }
            if let Some(end) = field_number(line, "freeze_end:") {
                if let Some(start) = freeze_start.take() {
                    intervals.extend(interval("freeze", start, end, duration, minimum, noise_db));
                }
            }
        }
        if line.contains("silencedetect") {
            if let Some(start) = field_number(line, "silence_start:") {
                silence_start = Some(start);
            }
            if let Some(end) = field_number(line, "silence_end:") {
                if let Some(start) = silence_start.take() {
                    intervals.extend(interval("silence", start, end, duration, minimum, noise_db));
                }
            }
        }
    }
    if let Some(start) = freeze_start {
        intervals.extend(interval(
            "freeze", start, duration, duration, minimum, noise_db,
        ));
    }
    if let Some(start) = silence_start {
        intervals.extend(interval(
            "silence", start, duration, duration, minimum, noise_db,
        ));
    }
    intervals.sort_by(|a, b| {
        a["start"]
            .as_f64()
            .unwrap_or(0.0)
            .total_cmp(&b["start"].as_f64().unwrap_or(0.0))
    });
    intervals
}

#[derive(Clone, Copy)]
pub struct IdleOptions {
    pub min_duration: f64,
    pub noise_db: f64,
    pub freeze_noise_db: f64,
    pub freeze_only: bool,
    pub start: f64,
    pub end: Option<f64>,
}
impl Default for IdleOptions {
    fn default() -> Self {
        Self {
            min_duration: 2.0,
            noise_db: -45.0,
            freeze_noise_db: -60.0,
            freeze_only: false,
            start: 0.0,
            end: None,
        }
    }
}

#[cfg(test)]
pub fn detect_idle(
    store: &MediaStore,
    runtime: &Runtime,
    asset: &Value,
    min_duration: f64,
    noise_db: f64,
    control: &TaskControl,
) -> Result<Value> {
    detect_idle_with_options(
        store,
        runtime,
        asset,
        IdleOptions {
            min_duration,
            noise_db,
            ..IdleOptions::default()
        },
        control,
    )
}

pub fn detect_idle_with_options(
    store: &MediaStore,
    runtime: &Runtime,
    asset: &Value,
    options: IdleOptions,
    control: &TaskControl,
) -> Result<Value> {
    control.check()?;
    let IdleOptions {
        min_duration,
        noise_db,
        freeze_noise_db,
        freeze_only,
        start,
        end,
    } = options;
    if !min_duration.is_finite()
        || !(0.05..=3600.0).contains(&min_duration)
        || !noise_db.is_finite()
        || !(-120.0..=0.0).contains(&noise_db)
        || !freeze_noise_db.is_finite()
        || !(-100.0..=-20.0).contains(&freeze_noise_db)
    {
        return Err("空闲检测最短时长需要在 0.05–3600 秒之间，静音阈值需要在 -120–0 dB 之间，静止画面变化阈值需要在 -100–-20 dB 之间。".into());
    }
    if !start.is_finite() || start < 0.0 || end.is_some_and(|end| !end.is_finite() || end <= start)
    {
        return Err("检测范围必须是有效的源视频时间区间。".into());
    }
    let path = store.authorized_path(asset)?;
    let info = read_probe(runtime, &path, control)?;
    let duration = duration(&info).ok_or("空闲检测需要具有明确时长的音频或视频素材。")?;
    if start >= duration || end.is_some_and(|end| end > duration + 0.1) {
        return Err("检测范围超出素材时长。".into());
    }
    let end = end.unwrap_or(duration).min(duration);
    let span = end - start;
    let video = video_stream(&info);
    let audio = audio_stream(&info).filter(|_| !freeze_only);
    if freeze_only && video.is_none() {
        return Err("静止画面检测需要视频流。".into());
    }
    if video.is_none() && audio.is_none() {
        return Err("素材没有可检测的音频或视频流。".into());
    }
    let mut command = process(&runtime.encoder);
    command
        .args([
            "-hide_banner",
            "-nostdin",
            "-nostats",
            "-loglevel",
            "info",
            "-protocol_whitelist",
            "file,pipe",
            "-format_whitelist",
            MEDIA_FORMATS,
            "-threads",
            "2",
            "-ss",
        ])
        .arg(format!("{start:.8}"))
        .arg("-i")
        .arg(&path)
        .arg("-t")
        .arg(format!("{span:.8}"));
    let mut detectors = Vec::new();
    if let Some(video) = video {
        command.arg("-map").arg(format!(
            "0:{}",
            video["index"].as_u64().ok_or("视频流索引无效。")?
        ));
        // Detection emits an interval only after comparing a subsequent frame. Let the
        // parser validate its full duration so an exact-threshold hold at EOF is retained.
        let freeze_detection_duration =
            (min_duration - frame_rate(video).map(|fps| 1.0 / fps).unwrap_or(0.0)).max(0.001);
        let black = if freeze_only {
            String::new()
        } else {
            format!("blackdetect=d={min_duration:.8}:pix_th=0.10:pic_th=0.98,")
        };
        command.arg("-vf").arg(format!("scale=w='min(iw,640)':h='min(ih,640)':force_original_aspect_ratio=decrease,{black}freezedetect=n={freeze_noise_db:.8}dB:d={freeze_detection_duration:.8}"));
        if !freeze_only {
            detectors.push("black");
        }
        detectors.push("freeze");
    }
    if let Some(audio) = audio {
        command.arg("-map").arg(format!(
            "0:{}",
            audio["index"].as_u64().ok_or("音频流索引无效。")?
        ));
        command.arg("-af").arg(format!(
            "silencedetect=n={noise_db:.8}dB:d={min_duration:.8}"
        ));
        detectors.push("silence");
    } else {
        command.arg("-an");
    }
    command.args([
        "-sn",
        "-dn",
        "-threads",
        "1",
        "-filter_threads",
        "1",
        "-f",
        "null",
        "-",
    ]);
    command.args(["-progress", "pipe:1", "-stats_period", "0.5"]);
    let output = run_process(command, control, MAX_ANALYSIS_BYTES)?;
    // Container duration can include a nonzero timestamp origin or longer audio.
    // Close a trailing visual hold at the actual decoded video end, not that metadata.
    let measured_span = if freeze_only {
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| line.strip_prefix("out_time_us="))
            .filter_map(|value| value.parse::<f64>().ok())
            .filter(|value| value.is_finite() && *value >= 0.0)
            .reduce(f64::max)
            .map(|value| value / 1_000_000.0)
            .unwrap_or(0.0)
            .min(span)
    } else {
        span
    };
    let mut intervals = idle_intervals(&output.stderr, measured_span, min_duration, noise_db);
    for interval in &mut intervals {
        interval["start"] = json!(interval["start"].as_f64().unwrap_or(0.0) + start);
        interval["end"] = json!(interval["end"].as_f64().unwrap_or(0.0) + start);
        if interval["kind"] == "freeze" {
            interval["evidence"]["differenceNoiseDb"] = json!(freeze_noise_db);
            interval["evidence"]["maximumAnalysisDimension"] = json!(640);
        }
    }
    if intervals.len() > MAX_INTERVALS {
        return Err("空闲候选区间超过 4096 个，请提高最短时长。".into());
    }
    // A freeze-only scan must not launch a second full-source decoding pass.
    // Ranged inspection similarly avoids claiming repetition coverage outside its bounds.
    let repeated = if freeze_only || start > 0.0 || end < duration {
        json!({ "repeatedIntervals": [], "scope": { "skipped": true, "start": start, "end": end },
            "threshold": null, "limitation": "当前仅扫描指定范围，未运行非相邻重复片段检测。" })
    } else {
        repetition::detect_repeated_intervals(store, runtime, asset, control)?
    };
    Ok(json!({
        "assetId": asset["id"], "duration": duration, "timeBase": "assetSeconds",
        "range": { "start": start, "end": start + measured_span }, "freezeNoiseDb": freeze_noise_db,
        "repeatedIntervals": repeated["repeatedIntervals"], "repetitionScope": repeated["scope"],
        "repetitionThreshold": repeated["threshold"], "repetitionLimitation": repeated["limitation"],
        "detectors": detectors, "intervals": intervals,
        "interpretation": "黑场、近似静止或静音是技术检测候选，阈值匹配不代表内容无用；不同类型区间可以重叠。",
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, sync::atomic::Ordering, time::Duration};

    fn runtime() -> Runtime {
        Runtime::discover(None, None).expect("真实媒体引擎应可用")
    }

    fn control() -> TaskControl {
        TaskControl::new(Duration::from_secs(30))
    }

    fn fixture() -> (tempfile::TempDir, MediaStore, Runtime, Value) {
        let directory = tempfile::tempdir().unwrap();
        let store = MediaStore::new(directory.path()).unwrap();
        let runtime = runtime();
        let path = store.root.join("analysis-fixture.mkv");
        let output = process(&runtime.encoder)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=black:s=96x64:r=10:d=1",
                "-f",
                "lavfi",
                "-i",
                "color=c=white:s=96x64:r=10:d=1",
                "-f",
                "lavfi",
                "-i",
                "anullsrc=r=16000:cl=mono",
                "-filter_complex",
                "[0:v][1:v]concat=n=2:v=1:a=0[v]",
                "-map",
                "[v]",
                "-map",
                "2:a",
                "-t",
                "2",
                "-c:v",
                "ffv1",
                "-c:a",
                "pcm_s16le",
                "-threads",
                "1",
                "-y",
            ])
            .arg(&path)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let asset = json!({"id": "analysis-video", "nativePath": path});
        (directory, store, runtime, asset)
    }

    #[test]
    fn real_media_probe_and_frame_include_structured_data_and_png() {
        let (_directory, store, runtime, asset) = fixture();
        let metadata = probe(&store, &runtime, &asset, &control()).unwrap();
        assert_eq!(metadata["hasVideo"], true);
        assert_eq!(metadata["hasAudio"], true);
        assert!((metadata["duration"].as_f64().unwrap() - 2.0).abs() < 0.1);
        assert_eq!(metadata["streams"][0]["width"], 96);
        assert_eq!(metadata["frameRate"], 10.0);
        assert_eq!(metadata["hasAlphaChannel"], false);
        assert!(!metadata
            .to_string()
            .contains(&store.root.to_string_lossy().to_string()));
        let image = frame(&store, &runtime, &asset, 0.75, 48, &control()).unwrap();
        assert_eq!(image["mimeType"], "image/png");
        assert_eq!(image["width"], 48);
        assert_eq!(image["height"], 32);
        assert!(image["base64"].as_str().unwrap().starts_with("iVBORw0KGgo"));
        assert!(
            (image["sourceTime"].as_f64().unwrap() - 0.8).abs() < 0.02,
            "{image}"
        );
        let sheet = storyboard(&store, &runtime, &asset, 0.0, None, 3, 48, &control()).unwrap();
        assert_eq!(sheet["frames"].as_array().unwrap().len(), 3);
        assert_ne!(sheet["frames"][0]["base64"], sheet["frames"][2]["base64"]);
        assert!(sheet["encodedBytes"].as_u64().unwrap() <= MAX_STORYBOARD_BYTES as u64);
    }

    #[test]
    fn scene_storyboard_uses_actual_detected_boundaries_and_preserves_source_times() {
        let (_directory, store, runtime, asset) = fixture();
        let sheet = storyboard_with_options(
            &store,
            &runtime,
            &asset,
            0.,
            Some(2.),
            8,
            48,
            "scene",
            0.2,
            &control(),
        )
        .unwrap();
        assert_eq!(sheet["mode"], "scene");
        assert_eq!(sheet["sceneCount"], 2);
        assert_eq!(sheet["truncated"], false);
        let frames = sheet["frames"].as_array().unwrap();
        assert_eq!(
            frames.len(),
            2,
            "few scenes must not be padded with uniform samples"
        );
        assert_ne!(frames[0]["base64"], frames[1]["base64"]);
        for (index, frame) in frames.iter().enumerate() {
            let source = frame["sourceTime"].as_f64().unwrap();
            assert!(
                source >= frame["sceneStart"].as_f64().unwrap()
                    && source < frame["sceneEnd"].as_f64().unwrap()
            );
            assert!((source - (index as f64 + 0.5)).abs() < 0.11);
        }
        assert!(frames[1]["sceneEvidence"]["score"].as_f64().unwrap() > 0.2);
        assert_eq!(
            frames[1]["sceneEvidence"]["evidence"]["detector"],
            "scene_difference"
        );
        let bounded = storyboard_with_options(
            &store,
            &runtime,
            &asset,
            0.5,
            Some(1.5),
            4,
            48,
            "scene",
            0.2,
            &control(),
        )
        .unwrap();
        assert_eq!(bounded["sceneCount"], 2);
        assert!(
            (bounded["frames"][1]["sceneStart"].as_f64().unwrap() - 1.).abs() < 0.02,
            "seeked detector timestamps remain source seconds: {bounded}"
        );
        for frame in bounded["frames"].as_array().unwrap() {
            assert!(
                frame["sourceTime"].as_f64().unwrap() >= 0.5
                    && frame["sourceTime"].as_f64().unwrap() < 1.5
            );
        }
    }

    #[test]
    fn scene_storyboard_reports_frame_limit_and_does_not_invent_changes_in_static_range() {
        let (_directory, store, runtime, asset) = fixture();
        let limited = storyboard_with_options(
            &store,
            &runtime,
            &asset,
            0.,
            Some(2.),
            1,
            48,
            "scene",
            0.2,
            &control(),
        )
        .unwrap();
        assert_eq!(limited["frames"].as_array().unwrap().len(), 1);
        assert_eq!(limited["sceneCount"], 2);
        assert_eq!(limited["truncated"], true);
        let static_range = storyboard_with_options(
            &store,
            &runtime,
            &asset,
            1.2,
            Some(1.8),
            12,
            48,
            "scene",
            0.2,
            &control(),
        )
        .unwrap();
        assert_eq!(static_range["sceneCount"], 1);
        assert_eq!(static_range["frames"].as_array().unwrap().len(), 1);
        assert_eq!(
            static_range["frames"][0]["sceneEvidence"]["kind"],
            "range_start"
        );
        assert!(storyboard_with_options(
            &store,
            &runtime,
            &asset,
            0.,
            None,
            4,
            48,
            "unknown",
            0.2,
            &control()
        )
        .is_err());
        assert!(storyboard_with_options(
            &store,
            &runtime,
            &asset,
            0.,
            None,
            4,
            48,
            "scene",
            f64::NAN,
            &control()
        )
        .is_err());
    }

    #[test]
    fn scene_storyboard_requires_explicit_bounded_range_on_long_media() {
        let (_directory, store, runtime, _) = fixture();
        let path = store.root.join("long-static.mkv");
        let output = process(&runtime.encoder)
            .args([
                "-hide_banner",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=blue:s=32x32:r=1/60:d=660",
                "-c:v",
                "ffv1",
                "-threads",
                "1",
                "-y",
            ])
            .arg(&path)
            .output()
            .unwrap();
        assert!(output.status.success());
        let asset = json!({"id":"long-static", "nativePath":path});
        let error = storyboard_with_options(
            &store,
            &runtime,
            &asset,
            0.,
            None,
            3,
            32,
            "scene",
            0.3,
            &control(),
        )
        .unwrap_err();
        assert!(error.contains("600"), "{error}");
        let bounded = storyboard_with_options(
            &store,
            &runtime,
            &asset,
            0.,
            Some(120.),
            3,
            32,
            "scene",
            0.3,
            &control(),
        )
        .unwrap();
        assert_eq!(bounded["sceneCount"], 1);
        assert_eq!(bounded["end"], 120.);
        assert_eq!(bounded["frames"][0]["sourceTime"], 60.);
    }

    #[test]
    fn probe_reports_real_alpha_channel_and_display_rotation() {
        let directory = tempfile::tempdir().unwrap();
        let store = MediaStore::new(directory.path()).unwrap();
        let runtime = runtime();
        let image = store.root.join("transparent.png");
        let mut command = process(&runtime.encoder);
        command
            .args([
                "-hide_banner",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=red:s=96x64,format=rgba,colorchannelmixer=aa=0.25",
                "-frames:v",
                "1",
                "-threads",
                "1",
                "-y",
            ])
            .arg(&image);
        run_process(command, &control(), 1024).unwrap();
        let info = probe(&store, &runtime, &json!({"nativePath":image}), &control()).unwrap();
        assert_eq!(info["hasAlphaChannel"], true);
        assert_eq!(info["streams"][0]["pixelFormat"], "rgba");
        let video = store.root.join("landscape.mp4");
        let mut command = process(&runtime.encoder);
        command
            .args([
                "-hide_banner",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=red:s=96x64:r=10:d=1",
                "-c:v",
                "libx264",
                "-threads",
                "1",
                "-y",
            ])
            .arg(&video);
        run_process(command, &control(), 1024).unwrap();
        let rotated = store.root.join("rotated.mp4");
        let mut command = process(&runtime.encoder);
        command
            .args([
                "-hide_banner",
                "-v",
                "error",
                "-display_rotation:v:0",
                "90",
                "-i",
            ])
            .arg(&video)
            .args(["-c", "copy", "-y"])
            .arg(&rotated);
        run_process(command, &control(), 1024).unwrap();
        let info = probe(&store, &runtime, &json!({"nativePath":rotated}), &control()).unwrap();
        assert_eq!(info["rotationDegrees"], 90.0);
        assert_eq!(info["width"], 64);
        assert_eq!(info["height"], 96);
    }

    #[test]
    fn real_scene_and_idle_detection_return_measured_evidence() {
        let (_directory, store, runtime, asset) = fixture();
        let scenes = detect_scenes(&store, &runtime, &asset, 0.2, 0.2, &control()).unwrap();
        let points = scenes["points"].as_array().unwrap();
        assert_eq!(points.len(), 1, "{scenes}");
        assert!((points[0]["time"].as_f64().unwrap() - 1.0).abs() < 0.1);
        assert!(points[0]["score"].as_f64().unwrap() > 0.2);
        let idle = detect_idle(&store, &runtime, &asset, 0.3, -50.0, &control()).unwrap();
        let intervals = idle["intervals"].as_array().unwrap();
        assert!(
            intervals.iter().any(|interval| interval["kind"] == "black"
                && interval["duration"].as_f64().unwrap() >= 0.9),
            "{idle}"
        );
        assert!(
            intervals
                .iter()
                .any(|interval| interval["kind"] == "freeze"),
            "{idle}"
        );
        assert!(
            intervals
                .iter()
                .any(|interval| interval["kind"] == "silence"
                    && interval["duration"].as_f64().unwrap() >= 1.9),
            "{idle}"
        );
        assert!(intervals
            .iter()
            .all(|interval| interval["evidence"]["detector"].is_string()));
    }

    fn freeze_fixture(
        filter: &str,
        seconds: f64,
    ) -> (tempfile::TempDir, MediaStore, Runtime, Value) {
        let directory = tempfile::tempdir().unwrap();
        let store = MediaStore::new(directory.path()).unwrap();
        let runtime = runtime();
        let path = store.root.join("freeze-range.mkv");
        let output = process(&runtime.encoder)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                filter,
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=16000",
                "-map",
                "0:v",
                "-map",
                "1:a",
                "-t",
            ])
            .arg(seconds.to_string())
            .args(["-c:v", "ffv1", "-c:a", "pcm_s16le", "-threads", "1", "-y"])
            .arg(&path)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let asset = json!({"id": "freeze-video", "nativePath": path});
        (directory, store, runtime, asset)
    }

    #[test]
    fn real_freeze_only_range_returns_source_seconds_and_trailing_hold() {
        let (_directory, store, runtime, asset) = freeze_fixture(
            "testsrc2=s=128x96:r=10:d=2[a];color=red:s=128x96:r=10:d=3[b];testsrc2=s=128x96:r=10:d=1[c];color=blue:s=128x96:r=10:d=2[d];[a][b][c][d]concat=n=4:v=1:a=0", 8.0);
        let result = detect_idle_with_options(
            &store,
            &runtime,
            &asset,
            IdleOptions {
                min_duration: 2.0,
                freeze_only: true,
                ..IdleOptions::default()
            },
            &control(),
        )
        .unwrap();
        let intervals = result["intervals"].as_array().unwrap();
        assert_eq!(result["detectors"], json!(["freeze"]));
        assert_eq!(result["repetitionScope"]["skipped"], true);
        assert_eq!(intervals.len(), 2, "{result}");
        assert!(
            (intervals[0]["start"].as_f64().unwrap() - 2.0).abs() < 0.11,
            "{result}"
        );
        assert!(
            (intervals[0]["end"].as_f64().unwrap() - 5.0).abs() < 0.11,
            "{result}"
        );
        assert!(
            (intervals[1]["start"].as_f64().unwrap() - 6.0).abs() < 0.11,
            "{result}"
        );
        assert_eq!(intervals[1]["end"], 8.0);
        let ranged = detect_idle_with_options(
            &store,
            &runtime,
            &asset,
            IdleOptions {
                min_duration: 1.0,
                freeze_only: true,
                start: 3.0,
                end: Some(6.0),
                ..IdleOptions::default()
            },
            &control(),
        )
        .unwrap();
        assert_eq!(ranged["range"], json!({"start":3.0,"end":6.0}));
        assert_eq!(ranged["intervals"].as_array().unwrap().len(), 1, "{ranged}");
        assert_eq!(ranged["intervals"][0]["start"], 3.0);
        assert_eq!(ranged["intervals"][0]["end"], 5.0);
        let short = detect_idle_with_options(
            &store,
            &runtime,
            &asset,
            IdleOptions {
                min_duration: 2.0,
                freeze_only: true,
                start: 3.5,
                end: Some(5.0),
                ..IdleOptions::default()
            },
            &control(),
        )
        .unwrap();
        assert!(short["intervals"].as_array().unwrap().is_empty(), "{short}");
    }

    #[test]
    fn real_freeze_threshold_distinguishes_small_noise_and_exact_length_still() {
        let (_directory, store, runtime, asset) =
            freeze_fixture("color=gray:s=128x96:r=10:d=2", 2.0);
        let still = detect_idle_with_options(
            &store,
            &runtime,
            &asset,
            IdleOptions {
                min_duration: 2.0,
                freeze_only: true,
                ..IdleOptions::default()
            },
            &control(),
        )
        .unwrap();
        assert_eq!(still["intervals"].as_array().unwrap().len(), 1, "{still}");
        assert_eq!(still["intervals"][0]["duration"], 2.0);
        let (_noise_directory, noise_store, runtime, noise_asset) = freeze_fixture(
            "color=gray:s=128x96:r=10:d=3,noise=alls=3:allf=t+u:all_seed=1",
            3.0,
        );
        let strict = detect_idle_with_options(
            &noise_store,
            &runtime,
            &noise_asset,
            IdleOptions {
                min_duration: 1.0,
                freeze_only: true,
                freeze_noise_db: -100.0,
                ..IdleOptions::default()
            },
            &control(),
        )
        .unwrap();
        assert!(
            strict["intervals"].as_array().unwrap().is_empty(),
            "{strict}"
        );
        let tolerant = detect_idle_with_options(
            &noise_store,
            &runtime,
            &noise_asset,
            IdleOptions {
                min_duration: 1.0,
                freeze_only: true,
                freeze_noise_db: -40.0,
                ..IdleOptions::default()
            },
            &control(),
        )
        .unwrap();
        assert_eq!(
            tolerant["intervals"].as_array().unwrap().len(),
            1,
            "{tolerant}"
        );
        assert_eq!(
            tolerant["intervals"][0]["evidence"]["differenceNoiseDb"],
            -40.0
        );
        assert_eq!(tolerant["intervals"][0]["duration"], 3.0);
    }

    #[test]
    fn real_freeze_with_nonzero_pts_closes_at_decoded_video_end() {
        let (_directory, store, runtime, asset) =
            freeze_fixture("color=gray:s=128x96:r=10:d=4", 4.0);
        let shifted = store.root.join("offset-video.mkv");
        let output = process(&runtime.encoder)
            .args(["-v", "error", "-i"])
            .arg(asset["nativePath"].as_str().unwrap())
            .args(["-c", "copy", "-output_ts_offset", "5", "-y"])
            .arg(&shifted)
            .output()
            .unwrap();
        assert!(output.status.success());
        let asset = json!({"id":"offset", "nativePath":shifted});
        let result = detect_idle_with_options(
            &store,
            &runtime,
            &asset,
            IdleOptions {
                min_duration: 1.0,
                freeze_only: true,
                start: 1.0,
                ..IdleOptions::default()
            },
            &control(),
        )
        .unwrap();
        assert_eq!(result["intervals"].as_array().unwrap().len(), 1, "{result}");
        assert_eq!(result["intervals"][0]["start"], 1.0);
        assert_eq!(result["intervals"][0]["end"], 4.0);
        assert_eq!(result["range"], json!({"start":1.0,"end":4.0}));
    }

    #[cfg(unix)]
    #[test]
    fn cancelling_freeze_scan_terminates_and_reaps_live_decoder() {
        use std::{os::unix::fs::PermissionsExt, thread, time::Instant};
        let (directory, store, mut runtime, asset) =
            freeze_fixture("color=gray:s=128x96:r=10:d=4", 4.0);
        let marker = directory.path().join("decoder.pid");
        let wrapper = directory.path().join("paced-decoder");
        let quote = |s: &str| format!("'{}'", s.replace('\'', "'\"'\"'"));
        fs::write(
            &wrapper,
            format!(
                "#!/bin/sh\necho $$ > {}\nexec {} -re \"$@\"\n",
                quote(marker.to_str().unwrap()),
                quote(runtime.encoder.to_str().unwrap())
            ),
        )
        .unwrap();
        fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o700)).unwrap();
        runtime.encoder = wrapper;
        let control = control();
        let cancel = control.cancelled.clone();
        let task = thread::spawn(move || {
            detect_idle_with_options(
                &store,
                &runtime,
                &asset,
                IdleOptions {
                    min_duration: 1.0,
                    freeze_only: true,
                    ..IdleOptions::default()
                },
                &control,
            )
        });
        let began = Instant::now();
        while !marker.exists() && began.elapsed() < Duration::from_secs(5) {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(marker.exists(), "decoder was not started");
        let pid = fs::read_to_string(&marker).unwrap().trim().to_owned();
        thread::sleep(Duration::from_millis(100));
        let cancelled_at = Instant::now();
        cancel.store(true, Ordering::Release);
        assert!(task.join().unwrap().unwrap_err().contains("取消"));
        assert!(cancelled_at.elapsed() < Duration::from_secs(2));
        let status = std::process::Command::new("kill")
            .args(["-0", &pid])
            .output()
            .unwrap();
        assert!(
            !status.status.success(),
            "cancelled decoder {pid} still exists"
        );
    }

    #[test]
    fn freeze_ranges_validate_and_cancel_before_media_work() {
        let (_directory, store, runtime, asset) = fixture();
        for options in [
            IdleOptions {
                start: f64::NAN,
                ..IdleOptions::default()
            },
            IdleOptions {
                start: -1.0,
                ..IdleOptions::default()
            },
            IdleOptions {
                start: 2.0,
                ..IdleOptions::default()
            },
            IdleOptions {
                end: Some(3.0),
                ..IdleOptions::default()
            },
            IdleOptions {
                start: 1.0,
                end: Some(1.0),
                ..IdleOptions::default()
            },
            IdleOptions {
                freeze_noise_db: -10.0,
                ..IdleOptions::default()
            },
        ] {
            assert!(
                detect_idle_with_options(&store, &runtime, &asset, options, &control()).is_err()
            );
        }
        let cancelled = control();
        cancelled.cancelled.store(true, Ordering::Release);
        assert!(detect_idle_with_options(
            &store,
            &runtime,
            &asset,
            IdleOptions::default(),
            &cancelled
        )
        .unwrap_err()
        .contains("取消"));
    }

    #[test]
    fn audio_detection_skips_video_and_refuses_frame_extraction() {
        let directory = tempfile::tempdir().unwrap();
        let store = MediaStore::new(directory.path()).unwrap();
        let runtime = runtime();
        let path = store.root.join("quiet.wav");
        let result = process(&runtime.encoder)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "anullsrc=r=16000:cl=mono",
                "-t",
                "0.6",
                "-y",
            ])
            .arg(&path)
            .output()
            .unwrap();
        assert!(result.status.success());
        let asset = json!({"id": "quiet", "nativePath": path});
        let idle = detect_idle(&store, &runtime, &asset, 0.1, -50.0, &control()).unwrap();
        assert_eq!(idle["detectors"], json!(["silence"]));
        assert_eq!(idle["intervals"][0]["kind"], "silence");
        assert!(frame(&store, &runtime, &asset, 0.0, 48, &control())
            .unwrap_err()
            .contains("视频流"));
        assert!(detect_scenes(&store, &runtime, &asset, 0.2, 0.2, &control()).is_err());
    }

    #[test]
    fn image_import_duration_handles_platform_frame_timing_and_long_animations() {
        let no_duration = json!({"format":{"format_name":"png_pipe"},"streams":[{"codec_type":"video","codec_name":"png"}]});
        let container_frame = json!({"format":{"format_name":"image2","duration":"0.040000"},"streams":[{"codec_type":"video","codec_name":"png"}]});
        let stream_frame = json!({"format":{"format_name":"image2"},"streams":[{"codec_type":"video","codec_name":"png","duration":"0.040000"}]});
        for info in [&no_duration, &container_frame, &stream_frame] {
            assert_eq!(import_duration("image", info), Some(5.0));
        }
        let animation = json!({"format":{"format_name":"gif","duration":"8.500000"},"streams":[{"codec_type":"video","codec_name":"gif","nb_frames":"85"}]});
        assert_eq!(import_duration("image", &animation), Some(8.5));
        // The minimum applies only to image clips, never to short audio or video.
        assert_eq!(import_duration("video", &container_frame), Some(0.04));
        assert_eq!(import_duration("audio", &stream_frame), Some(0.04));
        assert_eq!(import_duration("video", &no_duration), None);
        assert_eq!(duration(&container_frame), Some(0.04));
        assert_eq!(duration(&no_duration), None);
    }

    #[test]
    fn still_image_probe_and_frame_are_supported_but_playlists_are_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let store = MediaStore::new(directory.path()).unwrap();
        let runtime = runtime();
        let path = store.root.join("still.png");
        let output = process(&runtime.encoder)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=red:s=96x64",
                "-frames:v",
                "1",
                "-threads",
                "1",
                "-y",
            ])
            .arg(&path)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let asset = json!({"id":"still", "nativePath":path});
        let metadata = probe(&store, &runtime, &asset, &control()).unwrap();
        assert_eq!(metadata["kind"], "image");
        assert_eq!(metadata["mime"], "image/png");
        assert_eq!(metadata["duration"], 5.0);
        assert_eq!(
            metadata["sourceDuration"],
            json!(duration(&read_probe(&runtime, &path, &control()).unwrap()))
        );
        assert_eq!(
            frame(&store, &runtime, &asset, 0.0, 48, &control()).unwrap()["width"],
            48
        );
        let playlist = store.root.join("external.mkv");
        fs::write(&playlist, "ffconcat version 1.0\nfile 'still.png'\n").unwrap();
        let error = probe(
            &store,
            &runtime,
            &json!({"nativePath":playlist}),
            &control(),
        )
        .unwrap_err();
        assert!(error.contains("whitelist"), "{error}");
    }

    #[test]
    fn rejects_unauthorized_paths_invalid_ranges_and_cancelled_work() {
        let (_directory, store, runtime, asset) = fixture();
        let outside = tempfile::NamedTempFile::new().unwrap();
        fs::write(outside.path(), b"not media").unwrap();
        assert!(probe(
            &store,
            &runtime,
            &json!({"nativePath":outside.path()}),
            &control()
        )
        .unwrap_err()
        .contains("素材库"));
        assert!(frame(&store, &runtime, &asset, f64::NAN, 48, &control()).is_err());
        assert!(frame(&store, &runtime, &asset, 2.0, 48, &control()).is_err());
        assert!(storyboard(&store, &runtime, &asset, 0.0, None, 25, 48, &control()).is_err());
        assert!(storyboard(&store, &runtime, &asset, 1.0, Some(0.0), 3, 48, &control()).is_err());
        let cancelled = control();
        cancelled.cancelled.store(true, Ordering::Release);
        assert!(probe(&store, &runtime, &asset, &cancelled).is_err());
        assert!(detect_idle(
            &store,
            &runtime,
            &asset,
            0.3,
            -50.0,
            &TaskControl::new(Duration::ZERO)
        )
        .is_err());
    }

    #[test]
    fn parsing_preserves_threshold_evidence_and_closes_trailing_intervals() {
        let points = scene_points("frame:0 pts:10 pts_time:1\nlavfi.scene_score=0.4\nframe:1 pts:11 pts_time:1.1\nlavfi.scene_score=0.7\nframe:2 pts:30 pts_time:3\nlavfi.scene_score=0.5\n", 0.3, 0.5);
        assert_eq!(points.len(), 2);
        assert_eq!(points[0]["time"], 1.1);
        let intervals = idle_intervals("[freezedetect @ x] lavfi.freezedetect.freeze_start: 1\n[silencedetect @ x] silence_start: 1.5\n", 3.0, 0.5, -45.0);
        assert_eq!(intervals.len(), 2);
        assert_eq!(intervals[0]["end"], 3.0);
        assert_eq!(intervals[1]["evidence"]["noiseDb"], -45.0);
        assert!(interval("silence", 2.8, 9.0, 3.0, 0.5, -45.0).is_none());
    }
}
