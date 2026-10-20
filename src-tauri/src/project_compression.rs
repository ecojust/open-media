//! Non-destructive, cancellable compression of unique project video sources.
use crate::{
    asset_tools::{run_process, TaskControl},
    engine::{self, Asset, JobManager, MediaStore, RenderPlan, Result, Runtime, VideoTarget},
};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressionItem {
    pub source_ids: Vec<String>,
    pub source_size: u64,
    pub output_size: Option<u64>,
    pub asset: Option<Asset>,
    pub state: String,
    pub message: Option<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressionJob {
    pub id: String,
    pub state: String,
    pub progress: f64,
    pub stage: String,
    pub message: Option<String>,
    pub current: usize,
    pub total: usize,
    pub elapsed_seconds: f64,
    pub backend: Option<String>,
    pub items: Vec<CompressionItem>,
    pub error: Option<String>,
}
struct Entry {
    job: CompressionJob,
    cancelled: Arc<AtomicBool>,
    started: Instant,
    directory: Option<PathBuf>,
    accepted: bool,
    previews: usize,
}
#[derive(Clone, Default)]
pub struct CompressionManager {
    jobs: Arc<Mutex<HashMap<String, Entry>>>,
    encoders: JobManager,
}
#[derive(Clone)]
struct Source {
    path: PathBuf,
    name: String,
    ids: Vec<String>,
    size: u64,
    info: Value,
    duration: f64,
    fps: f64,
    format: String,
}

impl CompressionManager {
    pub fn begin(
        &self,
        store: &MediaStore,
        runtime: &Runtime,
        assets: Vec<Value>,
        mode: String,
        quality: String,
    ) -> Result<CompressionJob> {
        if !["lossless", "quality"].contains(&mode.as_str())
            || !["high", "balanced", "compact"].contains(&quality.as_str())
        {
            return Err("压缩模式或质量无效。".into());
        }
        if assets.is_empty() || assets.len() > 1000 {
            return Err("请选择 1 至 1000 个工程视频素材。".into());
        }
        let mut entries = self.jobs.lock().map_err(|_| "压缩任务状态不可用。")?;
        if entries.values().any(|entry| entry.job.state == "running") {
            return Err("已有工程视频压缩任务正在运行。".into());
        }
        if entries.len() >= 32 {
            entries.retain(|_, entry| !entry.accepted && entry.directory.is_some());
        }
        if entries.len() >= 32 {
            return Err("请先接收或清理已完成的压缩任务。".into());
        }
        let id = engine::new_id();
        let job = CompressionJob {
            id: id.clone(),
            state: "running".into(),
            progress: 0.0,
            stage: "正在检查工程视频".into(),
            message: None,
            current: 0,
            total: 0,
            elapsed_seconds: 0.0,
            backend: None,
            items: vec![],
            error: None,
        };
        let cancelled = Arc::new(AtomicBool::new(false));
        entries.insert(
            id.clone(),
            Entry {
                job: job.clone(),
                cancelled: cancelled.clone(),
                started: Instant::now(),
                directory: None,
                accepted: false,
                previews: 0,
            },
        );
        drop(entries);
        let manager = self.clone();
        let store = store.clone();
        let runtime = runtime.clone();
        let worker_id = id.clone();
        if let Err(error) = thread::Builder::new()
            .name("project-video-compression".into())
            .spawn(move || {
                let result = manager.run(
                    &worker_id, &store, &runtime, assets, &mode, &quality, &cancelled,
                );
                if let Ok(mut entries) = manager.jobs.lock() {
                    if let Some(entry) = entries.get_mut(&worker_id) {
                        entry.job.elapsed_seconds = entry.started.elapsed().as_secs_f64();
                        match result {
                            Ok(directory) if !cancelled.load(Ordering::Acquire) => {
                                entry.directory = Some(directory.keep());
                                entry.job.state = "completed".into();
                                entry.job.stage = "工程视频压缩完成".into();
                                entry.job.progress = 1.0;
                            }
                            result => {
                                entry.job.state = if cancelled.load(Ordering::Acquire) {
                                    "cancelled"
                                } else {
                                    "failed"
                                }
                                .into();
                                entry.job.stage = if entry.job.state == "cancelled" {
                                    "已取消压缩"
                                } else {
                                    "工程视频压缩失败"
                                }
                                .into();
                                entry.job.error =
                                    result.err().filter(|_| entry.job.state == "failed");
                                for item in &mut entry.job.items {
                                    item.asset = None;
                                    if item.state == "completed" || item.state == "running" {
                                        item.state = "skipped".into();
                                        item.message =
                                            Some("任务未接收，已清理压缩副本；原素材保留。".into());
                                    }
                                }
                            }
                        }
                    }
                }
            })
        {
            self.jobs.lock().unwrap().remove(&id);
            return Err(format!("无法开始工程视频压缩：{error}"));
        }
        Ok(job)
    }
    fn update(&self, id: &str, update: impl FnOnce(&mut CompressionJob)) {
        if let Ok(mut entries) = self.jobs.lock() {
            if let Some(entry) = entries.get_mut(id) {
                update(&mut entry.job);
            }
        }
    }
    pub fn get(&self, id: &str) -> Result<CompressionJob> {
        let entries = self.jobs.lock().map_err(|_| "压缩任务状态不可用。")?;
        let entry = entries.get(id).ok_or("压缩任务不存在。")?;
        let mut job = entry.job.clone();
        if job.state == "running" {
            job.elapsed_seconds = entry.started.elapsed().as_secs_f64();
        }
        Ok(job)
    }
    pub fn cancel(&self, id: &str) -> Result<()> {
        let entries = self.jobs.lock().map_err(|_| "压缩任务状态不可用。")?;
        let entry = entries.get(id).ok_or("压缩任务不存在。")?;
        if !entry.accepted {
            entry.cancelled.store(true, Ordering::Release);
        }
        Ok(())
    }
    pub fn accept(&self, id: &str) -> Result<()> {
        let mut entries = self.jobs.lock().map_err(|_| "压缩任务状态不可用。")?;
        let entry = entries.get_mut(id).ok_or("压缩任务不存在。")?;
        if entry.job.state != "completed"
            || entry.previews > 0
            || entry.cancelled.load(Ordering::Acquire)
        {
            return Err("压缩任务尚未完成或已取消，不能应用到工程。".into());
        }
        entry.accepted = true;
        Ok(())
    }
    pub fn discard(&self, id: &str) -> Result<()> {
        self.cancel(id)?;
        let deadline = Instant::now() + Duration::from_secs(20);
        while self
            .jobs
            .lock()
            .map_err(|_| "压缩任务状态不可用。")?
            .get(id)
            .is_some_and(|entry| entry.job.state == "running" || entry.previews > 0)
        {
            if Instant::now() >= deadline {
                return Err("正在取消压缩，请稍后清理。".into());
            }
            thread::sleep(Duration::from_millis(30));
        }
        let mut entries = self.jobs.lock().map_err(|_| "压缩任务状态不可用。")?;
        if entries.get(id).is_some_and(|entry| entry.accepted) {
            return Ok(());
        }
        if let Some(directory) = entries.get(id).and_then(|entry| entry.directory.as_ref()) {
            // Keep ownership on a filesystem error so a later discard can retry.
            if directory.exists() {
                fs::remove_dir_all(directory).map_err(|e| format!("无法清理压缩副本：{e}"))?;
            }
        }
        entries.remove(id);
        Ok(())
    }
    pub fn prepare_preview(
        &self,
        id: &str,
        asset_id: &str,
        format: Option<&str>,
        store: &MediaStore,
        runtime: &Runtime,
    ) -> Result<crate::preview::PreviewResult> {
        if !matches!(format, None | Some("mp4") | Some("webm")) {
            return Err("不支持这个视频预览格式。".into());
        }
        let (asset, directory, cancelled) = {
            let mut entries = self.jobs.lock().map_err(|_| "压缩任务状态不可用。")?;
            let entry = entries.get_mut(id).ok_or("压缩任务不存在。")?;
            if entry.accepted
                || entry.job.state != "completed"
                || entry.cancelled.load(Ordering::Acquire)
            {
                return Err("压缩任务未完成、已取消或已接收。".into());
            }
            let asset = entry
                .job
                .items
                .iter()
                .filter_map(|item| item.asset.as_ref())
                .find(|asset| asset.id == asset_id)
                .cloned()
                .ok_or("这个素材不属于当前压缩任务。")?;
            let directory = entry.directory.clone().ok_or("压缩副本目录不可用。")?;
            entry.previews += 1;
            entry.job.message = Some("正在准备可播放预览，可随时取消。".into());
            (asset, directory, entry.cancelled.clone())
        };
        let result = serde_json::to_value(asset)
            .map_err(|e| e.to_string())
            .and_then(|asset| {
                crate::preview::create_compression_preview(
                    store,
                    runtime,
                    &asset,
                    format,
                    &directory,
                    &control(&cancelled),
                )
            });
        if let Ok(mut entries) = self.jobs.lock() {
            if let Some(entry) = entries.get_mut(id) {
                entry.previews = entry.previews.saturating_sub(1);
                if entry.previews == 0 {
                    entry.job.message = Some(
                        if cancelled.load(Ordering::Acquire) {
                            "已取消预览准备。"
                        } else if result.is_ok() {
                            "压缩副本预览已就绪。"
                        } else {
                            "预览准备失败，原素材保留。"
                        }
                        .into(),
                    );
                }
            }
        }
        result
    }
    pub fn shutdown(&self) {
        if let Ok(entries) = self.jobs.lock() {
            for entry in entries.values() {
                entry.cancelled.store(true, Ordering::Release);
            }
        }
        self.encoders.shutdown();
        let ids = self
            .jobs
            .lock()
            .map(|entries| entries.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for id in ids {
            let _ = self.discard(&id);
        }
    }
    fn run(
        &self,
        id: &str,
        store: &MediaStore,
        runtime: &Runtime,
        assets: Vec<Value>,
        mode: &str,
        quality: &str,
        cancelled: &Arc<AtomicBool>,
    ) -> Result<tempfile::TempDir> {
        let control = control(cancelled);
        let sources = prepare(store, runtime, assets, &control)?;
        let count = sources.len();
        self.update(id, |job| {
            job.total = count;
            job.items = sources
                .iter()
                .map(|source| CompressionItem {
                    source_ids: source.ids.clone(),
                    source_size: source.size,
                    output_size: None,
                    asset: None,
                    state: "waiting".into(),
                    message: None,
                })
                .collect();
        });
        let directory = tempfile::Builder::new()
            .prefix("compressed-")
            .tempdir_in(&store.root)
            .map_err(|e| format!("无法创建压缩副本目录：{e}"))?;
        for (index, source) in sources.iter().enumerate() {
            control.check()?;
            self.update(id, |job| {
                job.current = index + 1;
                job.stage = format!("正在压缩 {}/{}：{}", index + 1, count, source.name);
                job.items[index].state = "running".into();
            });
            let output = directory.path().join(format!(
                "{}.{}",
                engine::new_id(),
                if source.format == "matroska" {
                    "mkv"
                } else {
                    "mp4"
                }
            ));
            let plan = build_plan(source, mode, quality)?;
            let child = self
                .encoders
                .begin_with_overwrite(runtime, plan, output.clone(), false)?;
            loop {
                let current = self.encoders.get(&child.id).ok_or("压缩编码任务丢失。")?;
                if current.state != "running" {
                    self.encoders.forget_finished(&child.id);
                }
                if cancelled.load(Ordering::Acquire) {
                    let _ = self.encoders.cancel(&child.id);
                }
                self.update(id, |job| {
                    job.progress = (index as f64 + current.progress * 0.95) / count as f64;
                    job.backend = current.backend.clone();
                    job.message = Some(format!(
                        "{} · 已编码 {} 帧 · {:.1} / {:.1} 秒{}",
                        current.stage,
                        current.encoded_frames,
                        current.output_time,
                        source.duration,
                        current
                            .fallback_reason
                            .as_ref()
                            .map(|value| format!(" · {value}"))
                            .unwrap_or_default()
                    ));
                });
                match current.state.as_str() {
                    "completed" => break,
                    "failed" => {
                        return Err(current.error.unwrap_or_else(|| "视频压缩编码失败。".into()))
                    }
                    "cancelled" => return Err("压缩已取消。".into()),
                    _ => thread::sleep(Duration::from_millis(80)),
                }
            }
            control.check()?;
            let size = fs::metadata(&output).map_err(|e| e.to_string())?.len();
            if size >= source.size {
                fs::remove_file(&output).map_err(|e| e.to_string())?;
                self.update(id, |job| {
                    let item = &mut job.items[index];
                    item.state = "skipped".into();
                    item.output_size = Some(size);
                    item.message = Some("压缩副本没有变小，已保留原素材。".into());
                    job.progress = (index + 1) as f64 / count as f64;
                });
                continue;
            }
            self.update(id, |job| {
                job.message = Some("正在校验尺寸、时间、颜色和音轨。".into())
            });
            let after = probe(runtime, &output, &control)?;
            validate_output(source, &after, mode, runtime, &output, &control)?;
            let name = format!(
                "{}（{}压缩）.{}",
                Path::new(&source.name)
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy(),
                if mode == "lossless" {
                    "无损"
                } else {
                    "质量"
                },
                if source.format == "matroska" {
                    "mkv"
                } else {
                    "mp4"
                }
            );
            let asset = store.probe(runtime, &output, &name)?;
            self.update(id, |job| {
                let item = &mut job.items[index];
                item.state = "completed".into();
                item.output_size = Some(size);
                item.asset = Some(asset);
                item.message = Some(format!(
                    "减少 {:.1}%",
                    (1.0 - size as f64 / source.size as f64) * 100.0
                ));
                job.progress = (index + 1) as f64 / count as f64;
            });
        }
        control.check()?;
        Ok(directory)
    }
}
fn control(cancelled: &Arc<AtomicBool>) -> TaskControl {
    let mut control = TaskControl::new(Duration::from_secs(24 * 3600));
    control.cancelled = cancelled.clone();
    control
}
fn probe(runtime: &Runtime, path: &Path, control: &TaskControl) -> Result<Value> {
    let mut command = engine::process(&runtime.probe);
    command
        .args([
            "-v",
            "error",
            "-show_format",
            "-show_streams",
            "-show_chapters",
            "-of",
            "json",
        ])
        .arg(path);
    let output = run_process(command, control, 4 * 1024 * 1024)?;
    serde_json::from_slice(&output.stdout).map_err(|_| "视频媒体信息无效。".into())
}
fn numeric(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str()?.parse().ok())
        .filter(|value| value.is_finite())
}
fn ratio(value: &Value) -> Option<f64> {
    let value = value.as_str()?;
    let (a, b) = value.split_once('/')?;
    let (a, b) = (a.parse::<f64>().ok()?, b.parse::<f64>().ok()?);
    (b != 0.0)
        .then_some(a / b)
        .filter(|v| v.is_finite() && *v > 0.0)
}
fn video(info: &Value) -> &Value {
    info["streams"]
        .as_array()
        .unwrap()
        .iter()
        .find(|stream| stream["codec_type"] == "video")
        .unwrap()
}
fn prepare(
    store: &MediaStore,
    runtime: &Runtime,
    assets: Vec<Value>,
    control: &TaskControl,
) -> Result<Vec<Source>> {
    let mut sources: Vec<Source> = vec![];
    let mut paths: HashMap<PathBuf, usize> = HashMap::new();
    let mut ids = HashSet::new();
    for asset in assets {
        control.check()?;
        let id = asset["id"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 256)
            .ok_or("视频素材标识无效。")?
            .to_string();
        if !ids.insert(id.clone()) {
            return Err("视频素材标识重复。".into());
        }
        if asset["kind"] != "video" {
            return Err("工程视频压缩只能处理视频素材。".into());
        }
        let path = store.authorized_path(&asset)?;
        if let Some(index) = paths.get(&path).copied() {
            sources.get_mut(index).ok_or("视频索引无效。")?.ids.push(id);
            continue;
        }
        let info = probe(runtime, &path, control)?;
        validate_source(&info)
            .map_err(|error| format!("{}：{error}", asset["name"].as_str().unwrap_or("视频")))?;
        let stream = video(&info);
        let duration = numeric(&info["format"]["duration"])
            .or_else(|| numeric(&stream["duration"]))
            .filter(|value| *value > 0.0 && *value <= 86400.0)
            .ok_or("视频时长无效或超过 24 小时。")?;
        let fps = ratio(&stream["avg_frame_rate"])
            .or_else(|| ratio(&stream["r_frame_rate"]))
            .filter(|value| *value <= 240.0)
            .ok_or("无法读取视频帧率。")?;
        let mp4 = info["streams"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|s| s["codec_type"] == "audio")
            .all(|s| {
                ["aac", "mp3", "ac3", "eac3", "alac"]
                    .contains(&s["codec_name"].as_str().unwrap_or(""))
            });
        paths.insert(path.clone(), sources.len());
        sources.push(Source {
            size: fs::metadata(&path).map_err(|e| e.to_string())?.len(),
            path,
            name: asset["name"].as_str().unwrap_or("视频").into(),
            ids: vec![id],
            info,
            duration,
            fps,
            format: if mp4 { "mp4" } else { "matroska" }.into(),
        });
    }
    Ok(sources)
}
fn validate_source(info: &Value) -> Result<()> {
    let streams = info["streams"]
        .as_array()
        .ok_or("视频没有可读取的媒体流。")?;
    if streams
        .iter()
        .filter(|s| s["codec_type"] == "video")
        .count()
        != 1
        || streams
            .iter()
            .any(|s| !["video", "audio"].contains(&s["codec_type"].as_str().unwrap_or("")))
    {
        return Err("暂不压缩包含多个画面、字幕、附件或数据流的视频，以免丢失内容。".into());
    }
    let stream = video(info);
    if !["yuv420p", "yuv422p", "yuv444p"].contains(&stream["pix_fmt"].as_str().unwrap_or("")) {
        return Err("当前工程压缩只支持 8 位 SDR YUV 视频；含透明通道、高位深或其他像素格式的原件保持不变。".into());
    }
    if ["smpte2084", "arib-std-b67"].contains(&stream["color_transfer"].as_str().unwrap_or(""))
        || stream["color_primaries"] == "bt2020"
    {
        return Err("HDR 或广色域视频暂不压缩，以免改变颜色。".into());
    }
    if stream["field_order"]
        .as_str()
        .is_some_and(|value| !["progressive", "unknown"].contains(&value))
    {
        return Err("交错扫描视频暂不压缩，以免改变画面。".into());
    }
    if numeric(&stream["tags"]["rotate"]).is_some_and(|value| value.rem_euclid(360.0).abs() > 0.01)
        || stream["side_data_list"].as_array().is_some_and(|items| {
            items.iter().any(|item| {
                item["side_data_type"] != "Display Matrix"
                    || numeric(&item["rotation"])
                        .unwrap_or(1.0)
                        .rem_euclid(360.0)
                        .abs()
                        > 0.01
            })
        })
    {
        return Err("包含旋转、HDR 或特殊显示信息的视频暂不压缩，以免改变画面。".into());
    }
    let (width, height) = (
        stream["width"].as_u64().unwrap_or(0),
        stream["height"].as_u64().unwrap_or(0),
    );
    if width == 0 || height == 0 || width > 16384 || height > 16384 {
        return Err("视频尺寸无效或超出编码范围。".into());
    }
    Ok(())
}
fn build_plan(source: &Source, mode: &str, quality: &str) -> Result<RenderPlan> {
    let stream = video(&source.info);
    let pix = stream["pix_fmt"].as_str().unwrap();
    let mut args: Vec<String> = ["-copyts", "-noautorotate", "-i"]
        .into_iter()
        .map(str::to_string)
        .collect();
    args.push(source.path.to_string_lossy().into());
    args.extend(
        [
            "-map",
            "0",
            "-map_metadata",
            "0",
            "-map_chapters",
            "0",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-pix_fmt",
            pix,
            "-fps_mode",
            "passthrough",
            "-enc_time_base",
            "demux",
            "-c:a",
            "copy",
            "-avoid_negative_ts",
            "disabled",
        ]
        .into_iter()
        .map(str::to_string),
    );
    args.extend(["-g".into(), source.fps.round().max(1.0).to_string()]);
    if mode == "lossless" {
        args.extend(["-qp".into(), "0".into()]);
    } else {
        args.extend([
            "-crf".into(),
            match quality {
                "high" => "18",
                "compact" => "28",
                _ => "23",
            }
            .into(),
        ]);
    }
    for option in ["color_range", "colorspace", "color_primaries", "color_trc"] {
        let key = match option {
            "colorspace" => "color_space",
            "color_trc" => "color_transfer",
            value => value,
        };
        if let Some(value) = stream[key]
            .as_str()
            .filter(|value| !["unknown", "unspecified"].contains(value))
        {
            args.extend([format!("-{option}"), value.into()]);
        }
    }
    if source.format == "mp4" {
        args.extend(["-movflags".into(), "+faststart".into()]);
        if let Some(time_base) = stream["time_base"].as_str() {
            if let Some((num, den)) = time_base.split_once('/') {
                if let (Ok(num), Ok(den)) = (num.parse::<u64>(), den.parse::<u64>()) {
                    if num > 0 && den % num == 0 && den / num <= i32::MAX as u64 {
                        args.extend(["-video_track_timescale".into(), (den / num).to_string()]);
                    }
                }
            }
        }
    }
    // Keep the source pixel layout. Hardware paths are selected only for their
    // supported 4:2:0 input; lossless always keeps the explicit software settings.
    let video = if mode == "quality" && pix == "yuv420p" {
        let bitrate =
            numeric(&stream["bit_rate"]).or_else(|| numeric(&source.info["format"]["bit_rate"]));
        if let Some(bitrate) = bitrate.filter(|value| *value > 0.0) {
            // Only the hardware rewrite consumes this limit. CRF software output
            // does not need a bitrate target, so its fallback remains quality based.
            let factor = match quality {
                "high" => 0.85,
                "compact" => 0.50,
                _ => 0.68,
            };
            args.extend([
                "-b:v".into(),
                (bitrate * factor).round().max(32000.0).to_string(),
            ]);
        }
        Some(VideoTarget {
            width: stream["width"].as_u64().unwrap() as u32,
            height: stream["height"].as_u64().unwrap() as u32,
            fps: source.fps,
            quality: quality.into(),
        })
    } else {
        None
    };
    Ok(RenderPlan {
        args,
        duration: source.duration,
        format: source.format.clone(),
        workspace: tempfile::tempdir().map_err(|e| e.to_string())?,
        video,
    })
}
fn validate_output(
    source: &Source,
    info: &Value,
    mode: &str,
    runtime: &Runtime,
    output: &Path,
    control: &TaskControl,
) -> Result<()> {
    validate_source(info)?;
    let before = video(&source.info);
    let after = video(info);
    for key in ["width", "height", "pix_fmt", "sample_aspect_ratio"] {
        if before[key] != after[key] {
            return Err(format!("压缩结果的 {key} 与原视频不同，未应用到工程。"));
        }
    }
    for key in [
        "color_range",
        "color_space",
        "color_transfer",
        "color_primaries",
    ] {
        if before[key]
            .as_str()
            .is_some_and(|value| !["unknown", "unspecified"].contains(&value))
            && before[key] != after[key]
        {
            return Err(format!("压缩结果的 {key} 发生变化，未应用到工程。"));
        }
    }
    if let (Some(a), Some(b)) = (numeric(&before["nb_frames"]), numeric(&after["nb_frames"])) {
        if a != b
            && visible_packets(runtime, &source.path, control)?
                != visible_packets(runtime, output, control)?
        {
            return Err("压缩视频帧数发生变化，未应用到工程。".into());
        }
    }
    let duration = numeric(&info["format"]["duration"]).ok_or("无法校验压缩视频时长。")?;
    if (duration - source.duration).abs() > 0.05 {
        return Err("压缩视频时长发生变化，未应用到工程。".into());
    }
    if (numeric(&source.info["format"]["start_time"]).unwrap_or(0.0)
        - numeric(&info["format"]["start_time"]).unwrap_or(0.0))
    .abs()
        > 0.01
    {
        return Err("压缩视频起始时间发生变化，未应用到工程。".into());
    }
    for (a, b) in source.info["streams"]
        .as_array()
        .unwrap()
        .iter()
        .zip(info["streams"].as_array().unwrap())
    {
        if a["codec_type"] != b["codec_type"] {
            return Err("压缩结果的媒体流顺序发生变化。".into());
        }
        for (key, tolerance) in [("start_time", 0.005), ("duration", 0.05)] {
            if let (Some(a), Some(b)) = (numeric(&a[key]), numeric(&b[key])) {
                if (a - b).abs() > tolerance {
                    return Err(format!("压缩结果的媒体流 {key} 发生变化，未应用到工程。"));
                }
            }
        }
    }
    if let (Some(average), Some(nominal), Some(output_average)) = (
        ratio(&before["avg_frame_rate"]),
        ratio(&before["r_frame_rate"]),
        ratio(&after["avg_frame_rate"]),
    ) {
        if (average - nominal).abs() < 0.00001 && (average - output_average).abs() > 0.01 {
            return Err("压缩结果的固定帧率发生变化，未应用到工程。".into());
        }
    }
    let original_audio = source.info["streams"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|s| s["codec_type"] == "audio")
        .collect::<Vec<_>>();
    let output_audio = info["streams"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|s| s["codec_type"] == "audio")
        .collect::<Vec<_>>();
    if original_audio.len() != output_audio.len()
        || original_audio.iter().zip(output_audio).any(|(a, b)| {
            ["codec_name", "channels", "sample_rate"]
                .iter()
                .any(|key| a[*key] != b[*key])
        })
    {
        return Err("压缩结果的音轨发生变化，未应用到工程。".into());
    }
    if mode == "lossless" && before["pix_fmt"] != after["pix_fmt"] {
        return Err("无损压缩未保留原始像素格式。".into());
    }
    Ok(())
}

#[cfg(test)]
#[path = "project_compression_tests.rs"]
mod tests;

// Some containers count packets explicitly marked as discarded by an edit list.
// On a metadata count mismatch, scan only packet flags; no video is decoded.
fn visible_packets(runtime: &Runtime, path: &Path, control: &TaskControl) -> Result<usize> {
    let mut command = engine::process(&runtime.probe);
    command
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "packet=flags",
            "-of",
            "csv=p=0",
        ])
        .arg(path);
    let result = run_process(command, control, 16 * 1024 * 1024)?;
    Ok(String::from_utf8_lossy(&result.stdout)
        .lines()
        .filter(|line| !line.trim().is_empty() && !line.contains('D'))
        .count())
}
