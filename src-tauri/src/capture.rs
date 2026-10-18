use crate::engine::{new_id, process, Asset, MediaStore, Result, Runtime};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Child, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureOptions {
    pub request_id: Option<String>,
    pub fps: u32,
    pub microphone: bool,
    pub source_id: Option<String>,
    pub screen_id: Option<String>,
    pub audio_device: Option<String>,
    pub region: Option<Region>,
    pub output_size: Option<OutputSize>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Region {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct OutputSize {
    pub width: u32,
    pub height: u32,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CaptureBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureDevice {
    pub id: String,
    pub name: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds: Option<CaptureBounds>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scale_factor: Option<f64>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStatus {
    pub state: String,
    pub muted: bool,
    pub audio_available: bool,
    pub microphone_enabled: bool,
    pub elapsed: f64,
    pub segments: usize,
    pub error: Option<String>,
    pub source_id: Option<String>,
    pub source_name: Option<String>,
    pub source_width: Option<u32>,
    pub source_height: Option<u32>,
    pub output_size: Option<OutputSize>,
}
#[derive(Default)]
pub struct CaptureStartCancellation {
    tokens: Mutex<HashMap<String, Arc<AtomicBool>>>,
}
impl CaptureStartCancellation {
    pub fn token(&self, id: &str) -> Result<Arc<AtomicBool>> {
        if id.is_empty()
            || id.len() > 128
            || !id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        {
            return Err("录制请求编号无效。".into());
        }
        let mut tokens = self.tokens.lock().map_err(|_| "录制请求状态不可用。")?;
        if !tokens.contains_key(id) && tokens.len() >= 256 {
            return Err("待处理录制请求过多，请重新打开应用。".into());
        }
        Ok(tokens
            .entry(id.into())
            .or_insert_with(|| Arc::new(AtomicBool::new(false)))
            .clone())
    }
    pub fn cancel(&self, id: &str) -> Result<()> {
        self.token(id)?.store(true, Ordering::SeqCst);
        Ok(())
    }
    pub fn complete(&self, id: &str) {
        if let Ok(mut tokens) = self.tokens.lock() {
            tokens.remove(id);
        }
    }
    pub fn cancel_all(&self) {
        if let Ok(tokens) = self.tokens.lock() {
            for token in tokens.values() {
                token.store(true, Ordering::SeqCst);
            }
        }
    }
}
fn check_cancelled(cancelled: &AtomicBool) -> Result<()> {
    if cancelled.load(Ordering::SeqCst) {
        Err("录制已取消。".into())
    } else {
        Ok(())
    }
}
struct ActiveSegment {
    child: Child,
    path: PathBuf,
    error_file: PathBuf,
    started: Instant,
    #[cfg(target_os = "windows")]
    border: Option<crate::capture_windows::BorderIndicator>,
}
pub struct CaptureManager {
    runtime: Option<Runtime>,
    options: Option<CaptureOptions>,
    source: Option<CaptureDevice>,
    workspace: Option<tempfile::TempDir>,
    active: Option<ActiveSegment>,
    segments: Vec<PathBuf>,
    elapsed: f64,
    state: String,
    error: Option<String>,
    muted: bool,
}
impl Default for CaptureManager {
    fn default() -> Self {
        Self {
            runtime: None,
            options: None,
            source: None,
            workspace: None,
            active: None,
            segments: vec![],
            elapsed: 0.0,
            state: "idle".into(),
            error: None,
            muted: false,
        }
    }
}
impl Drop for CaptureManager {
    fn drop(&mut self) {
        self.abort();
    }
}
impl CaptureManager {
    pub fn status(&mut self) -> CaptureStatus {
        #[cfg(target_os = "windows")]
        if let Some(error) = self
            .active
            .as_ref()
            .and_then(|active| active.border.as_ref())
            .and_then(|border| border.error())
        {
            let _ = self.finish_segment();
            self.state = "paused".into();
            self.error = Some(error);
        }
        let ended = self
            .active
            .as_mut()
            .and_then(|active| match active.child.try_wait() {
                Ok(Some(_)) => Some(fs::read_to_string(&active.error_file).unwrap_or_default()),
                Err(error) => Some(error.to_string()),
                Ok(None) => None,
            });
        if let Some(detail) = ended {
            if let Some(mut active) = self.active.take() {
                let _ = active.child.kill();
                let _ = active.child.wait();
                self.elapsed += active.started.elapsed().as_secs_f64();
                #[cfg(target_os = "windows")]
                drop(active.border.take());
                if self.recoverable(&active.path) {
                    self.segments.push(active.path);
                }
            }
            self.state = "paused".into();
            self.error = Some(format!(
                "录制已暂停，请检查录制窗口和设备授权；已完成片段仍然保留。{}",
                tail(&detail, 800)
            ));
        }
        CaptureStatus {
            state: self.state.clone(),
            muted: self.muted,
            audio_available: self
                .options
                .as_ref()
                .is_some_and(|options| options.microphone),
            microphone_enabled: self
                .options
                .as_ref()
                .is_some_and(|options| options.microphone)
                && !self.muted,
            elapsed: self.elapsed
                + self
                    .active
                    .as_ref()
                    .map(|a| a.started.elapsed().as_secs_f64())
                    .unwrap_or(0.0),
            segments: self.segments.len() + usize::from(self.active.is_some()),
            error: self.error.clone(),
            source_id: self.source.as_ref().map(|s| s.id.clone()),
            source_name: self.source.as_ref().map(|s| s.name.clone()),
            source_width: self.source.as_ref().and_then(|s| s.width),
            source_height: self.source.as_ref().and_then(|s| s.height),
            output_size: self.options.as_ref().and_then(|o| o.output_size),
        }
    }
    fn recoverable(&self, path: &Path) -> bool {
        let Some(runtime) = self.runtime.as_ref() else {
            return false;
        };
        if !fs::metadata(path).map(|m| m.len() > 0).unwrap_or(false) {
            return false;
        }
        process(&runtime.probe)
            .args([
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=codec_type",
                "-of",
                "csv=p=0",
            ])
            .arg(path)
            .output()
            .map(|output| {
                output.status.success() && String::from_utf8_lossy(&output.stdout).contains("video")
            })
            .unwrap_or(false)
    }
    pub fn start(&mut self, runtime: &Runtime, options: CaptureOptions) -> Result<CaptureStatus> {
        self.start_cancellable(runtime, options, &AtomicBool::new(false))
    }
    pub fn start_cancellable(
        &mut self,
        runtime: &Runtime,
        mut options: CaptureOptions,
        cancelled: &AtomicBool,
    ) -> Result<CaptureStatus> {
        check_cancelled(cancelled)?;
        if self.state != "idle" {
            return Err("请先结束当前录制。".into());
        }
        if !(1..=60).contains(&options.fps) {
            return Err("录制帧率应为 1 至 60。".into());
        }
        let devices = list_devices_with_permission(runtime, true, cancelled)?;
        let source = select_source(&devices, &options)?;
        options.output_size = Some(resolve_output(&source, &options)?);
        options.source_id = Some(source.id.clone());
        options.screen_id = None;
        prepare_audio_choice(&devices, &mut options)?;
        check_cancelled(cancelled)?;
        self.runtime = Some(runtime.clone());
        self.options = Some(options);
        self.source = Some(source);
        self.workspace = Some(tempfile::tempdir().map_err(|e| e.to_string())?);
        self.segments.clear();
        self.elapsed = 0.0;
        self.error = None;
        self.muted = false;
        if let Err(error) = self.spawn_segment(cancelled) {
            self.state = "idle".into();
            self.workspace = None;
            self.options = None;
            self.source = None;
            return Err(error);
        }
        if let Err(error) = check_cancelled(cancelled) {
            self.abort();
            return Err(error);
        }
        Ok(self.status())
    }
    fn spawn_segment(&mut self, cancelled: &AtomicBool) -> Result<()> {
        check_cancelled(cancelled)?;
        let runtime = self.runtime.as_ref().ok_or("录制引擎不可用。")?;
        let options = self.options.as_ref().ok_or("录制设置不可用。")?;
        let id = options
            .source_id
            .as_deref()
            .ok_or("请选择录制屏幕或窗口。")?;
        let source = resolve_source(runtime, id, cancelled)?;
        resolve_output(&source, options)?;
        let root = self.workspace.as_ref().ok_or("录制目录不可用。")?.path();
        let id = new_id();
        let output = root.join(format!(
            "{id}.{}",
            if cfg!(target_os = "macos") {
                "mp4"
            } else {
                "mkv"
            }
        ));
        let error_file = root.join(format!("{id}.log"));
        let readiness = root.join(format!("{id}.progress"));
        let stderr = fs::File::create(&error_file).map_err(|e| e.to_string())?;
        #[cfg(target_os = "windows")]
        let (mut command, border) = {
            use crate::capture_windows::{self, BorderIndicator};
            let target = capture_windows::resolve_target(&source.id)?;
            let region = windows_region(options.region.as_ref());
            let bounds = capture_windows::capture_bounds(&target, region.as_ref())?;
            let mut command = process(&runtime.encoder);
            command.args([
                "-hide_banner",
                "-y",
                "-loglevel",
                "warning",
                "-stats_period",
                "0.1",
                "-progress",
            ]);
            command.arg(&readiness);
            command.args([
                "-f",
                "gdigrab",
                "-framerate",
                &options.fps.to_string(),
                "-draw_mouse",
                "1",
            ]);
            if source.kind == "window" {
                let hwnd = capture_windows::window_handle(&source.id)?;
                command.args(["-i", &format!("hwnd={hwnd}")]);
            } else {
                command.args([
                    "-offset_x",
                    &bounds.x.to_string(),
                    "-offset_y",
                    &bounds.y.to_string(),
                    "-video_size",
                    &format!("{}x{}", bounds.width, bounds.height),
                    "-i",
                    "desktop",
                ]);
            }
            if options.microphone {
                let device = options.audio_device.as_deref().ok_or("请选择麦克风。")?;
                command.args([
                    "-thread_queue_size",
                    "1024",
                    "-f",
                    "dshow",
                    "-i",
                    &format!("audio={device}"),
                ]);
            }
            command.args([
                "-vf",
                &output_filter(options.output_size.ok_or("请选择输出尺寸。")?, options.fps),
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-crf",
                "20",
                "-pix_fmt",
                "yuv420p",
            ]);
            if options.microphone {
                command.args([
                    "-af",
                    if self.muted {
                        "volume@capture_volume=0"
                    } else {
                        "volume@capture_volume=1"
                    },
                    "-c:a",
                    "aac",
                    "-b:a",
                    "128k",
                    "-ar",
                    "48000",
                    "-ac",
                    "2",
                ]);
            } else {
                command.arg("-an");
            }
            command.arg(&output).stdout(Stdio::null());
            let border = BorderIndicator::start(target, region)?;
            (command, border)
        };
        #[cfg(target_os = "macos")]
        let mut command = {
            let config = root.join(format!("{id}.json"));
            let mut configuration = serde_json::to_value(options).map_err(|e| e.to_string())?;
            configuration["muted"] = serde_json::Value::Bool(self.muted);
            fs::write(
                &config,
                serde_json::to_vec(&configuration).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            let mut command = crate::capture_service::command()?;
            command
                .arg("record")
                .arg(config)
                .arg(&output)
                .stdout(Stdio::from(
                    fs::File::create(&readiness).map_err(|e| e.to_string())?,
                ));
            command
        };
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        let mut command = unsupported_capture()?;
        check_cancelled(cancelled)?;
        command.stdin(Stdio::piped()).stderr(Stdio::from(stderr));
        let mut child = command.spawn().map_err(|e| format!("无法启动录屏：{e}"))?;
        if let Err(error) = wait_until_ready(
            &mut child,
            &readiness,
            &error_file,
            cfg!(target_os = "macos"),
            cancelled,
        ) {
            stop_child(&mut child, Duration::from_secs(2));
            return Err(error);
        }
        #[cfg(target_os = "windows")]
        if let Some(error) = border.error() {
            stop_child(&mut child, Duration::from_secs(2));
            return Err(error);
        }
        if let Err(error) = check_cancelled(cancelled) {
            stop_child(&mut child, Duration::from_secs(2));
            return Err(error);
        }
        self.source = Some(source);
        self.active = Some(ActiveSegment {
            child,
            path: output,
            error_file,
            started: Instant::now(),
            #[cfg(target_os = "windows")]
            border: Some(border),
        });
        self.state = "recording".into();
        self.error = None;
        Ok(())
    }
    fn finish_segment(&mut self) -> Result<()> {
        let Some(mut active) = self.active.take() else {
            return Ok(());
        };
        #[cfg(target_os = "windows")]
        drop(active.border.take());
        let result = stop_child(&mut active.child, Duration::from_secs(10));
        self.elapsed += active.started.elapsed().as_secs_f64();
        if (result
            && fs::metadata(&active.path)
                .map(|m| m.len() > 0)
                .unwrap_or(false))
            || self.recoverable(&active.path)
        {
            self.segments.push(active.path);
            Ok(())
        } else {
            self.error = Some("当前录制片段未能完整保存，之前已完成的片段仍然保留。".into());
            Err(self.error.clone().unwrap())
        }
    }
    pub fn pause(&mut self) -> Result<CaptureStatus> {
        if self.state != "recording" {
            return Err("当前没有正在进行的录制。".into());
        }
        let result = self.finish_segment();
        self.state = "paused".into();
        result?;
        Ok(self.status())
    }
    pub fn controls_target(&self) -> Option<(CaptureDevice, Option<Region>)> {
        Some((self.source.clone()?, self.options.as_ref()?.region.clone()))
    }
    pub fn set_microphone_enabled(&mut self, enabled: bool) -> Result<CaptureStatus> {
        self.set_microphone_enabled_cancellable(enabled, &AtomicBool::new(false))
    }
    pub fn set_microphone_enabled_cancellable(
        &mut self,
        enabled: bool,
        cancelled: &AtomicBool,
    ) -> Result<CaptureStatus> {
        check_cancelled(cancelled)?;
        self.status();
        if self.state != "recording" && self.state != "paused" {
            return Err("当前没有可控制的录制。".into());
        }
        let options = self.options.as_ref().ok_or("录制设置不可用。")?;
        if options.microphone == enabled {
            return if enabled && self.muted {
                self.set_muted(false)
            } else {
                Ok(self.status())
            };
        }
        let mut device = options.audio_device.clone();
        if enabled {
            // Authorization and device checks run while the current video keeps
            // recording. A denied request must never discard or pause that video.
            let runtime = self.runtime.as_ref().ok_or("录制引擎不可用。")?;
            let devices = list_devices_with_permission(runtime, false, cancelled)?;
            device = Some(
                select_audio_device(&devices, device.as_deref())
                    .map_err(|error| format!("{error}当前录制将保持原来的麦克风状态。"))?
                    .id
                    .clone(),
            );
            preflight_microphone(runtime, device.as_deref().unwrap(), cancelled)?;
        }
        check_cancelled(cancelled)?;
        self.switch_microphone(enabled, device, cancelled, |manager, _recovery| {
            // A stop/exit request also cancels an attempted recovery; never start
            // another capture process after the pending control was cancelled.
            manager.spawn_segment(cancelled)
        })
    }
    fn switch_microphone(
        &mut self,
        enabled: bool,
        device: Option<String>,
        cancelled: &AtomicBool,
        mut spawn: impl FnMut(&mut Self, bool) -> Result<()>,
    ) -> Result<CaptureStatus> {
        check_cancelled(cancelled)?;
        let previous = self.options.clone().ok_or("录制设置不可用。")?;
        let previous_muted = self.muted;
        let recording = self.state == "recording";
        if recording {
            let finished = self.finish_segment();
            self.state = "paused".into();
            finished?;
        }
        check_cancelled(cancelled)?;
        let options = self.options.as_mut().unwrap();
        options.microphone = enabled;
        options.audio_device = device;
        self.muted = false;
        self.error = None;
        if recording {
            if let Err(error) = spawn(self, false) {
                self.state = "paused".into();
                if cancelled.load(Ordering::SeqCst) {
                    if enabled {
                        self.options = Some(previous);
                        self.muted = previous_muted;
                    }
                    // Keep completed segments for the pending stop operation.
                    // Cancellation must not reopen the old recording process.
                    return Err("录制已取消。".into());
                }
                let message = if enabled {
                    // Restore the usable silent recording after an unavailable
                    // device, without deleting any already completed segments.
                    self.options = Some(previous);
                    self.muted = previous_muted;
                    match spawn(self, true) {
                        Ok(()) => format!("无法开启麦克风，已按原设置继续录制。{error}"),
                        Err(recovery) => {
                            self.state = "paused".into();
                            format!("无法开启麦克风，录制已暂停；已完成片段仍然保留。{error} 恢复录制失败：{recovery}")
                        }
                    }
                } else {
                    // A failed silent restart must not reopen a microphone the
                    // user explicitly disabled. Resume remains available.
                    format!(
                        "麦克风已关闭，但画面录制未能继续；录制已暂停，已完成片段仍然保留。{error}"
                    )
                };
                self.error = Some(message.clone());
                return Err(message);
            }
        }
        Ok(self.status())
    }
    pub fn set_muted(&mut self, muted: bool) -> Result<CaptureStatus> {
        // Refresh an unexpectedly ended child before writing to its input.
        self.status();
        if self.state != "recording" && self.state != "paused" {
            return Err("当前没有可控制的录制。".into());
        }
        if !self
            .options
            .as_ref()
            .is_some_and(|options| options.microphone)
        {
            return Err("本次录制未启用声音。".into());
        }
        if self.muted != muted {
            if let Some(active) = self.active.as_mut() {
                let input = active.child.stdin.as_mut().ok_or("录制声音控制不可用。")?;
                input
                    .write_all(mute_command(muted, cfg!(target_os = "macos")))
                    .and_then(|_| input.flush())
                    .map_err(|error| format!("无法切换录制声音：{error}"))?;
            }
            self.muted = muted;
        }
        Ok(self.status())
    }
    pub fn resume(&mut self) -> Result<CaptureStatus> {
        if self.state != "paused" {
            return Err("当前录制未暂停。".into());
        }
        self.spawn_segment(&AtomicBool::new(false))
            .inspect_err(|error| {
                self.error = Some(error.clone());
            })?;
        Ok(self.status())
    }
    pub fn stop(&mut self, store: &MediaStore) -> Result<Option<Asset>> {
        if self.state == "idle" {
            return Ok(None);
        }
        self.state = "stopping".into();
        let finish = self.finish_segment();
        if self.segments.is_empty() {
            self.state = "idle".into();
            self.workspace = None;
            self.options = None;
            self.source = None;
            self.muted = false;
            finish?;
            return Ok(None);
        }
        let imported = self.merge_segments(store);
        if imported.is_ok() {
            self.state = "idle".into();
            self.workspace = None;
            self.segments.clear();
            self.elapsed = 0.0;
            self.error = None;
            self.options = None;
            self.source = None;
            self.muted = false;
        } else {
            self.state = "paused".into();
            self.error = imported.as_ref().err().cloned();
        }
        imported.map(Some)
    }
    fn merge_segments(&self, store: &MediaStore) -> Result<Asset> {
        let runtime = self.runtime.as_ref().ok_or("录制引擎不可用。")?;
        let root = self.workspace.as_ref().ok_or("录制目录不可用。")?.path();
        let descriptions = self
            .segments
            .iter()
            .map(|path| recording_segment_info(runtime, path))
            .collect::<Result<Vec<_>>>()?;
        let mixed_audio = descriptions.iter().any(|info| info.audio)
            && descriptions.iter().any(|info| !info.audio);
        let segments = if mixed_audio {
            self.segments
                .iter()
                .zip(&descriptions)
                .enumerate()
                .map(|(index, (path, info))| {
                    normalize_recording_audio(runtime, root, index, path, info)
                })
                .collect::<Result<Vec<_>>>()?
        } else {
            self.segments.clone()
        };
        let list = root.join("segments.txt");
        let content = segments
            .iter()
            .zip(&descriptions)
            .map(|(p, info)| {
                let file = format!(
                    "file '{}'",
                    p.to_string_lossy()
                        .replace('\\', "/")
                        .replace('\'', "'\\''")
                );
                if mixed_audio {
                    format!("{file}\nduration {:.9}", info.duration)
                } else {
                    file
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(&list, content).map_err(|e| e.to_string())?;
        let output = root.join("recording.mp4");
        let mut command = process(&runtime.encoder);
        command
            .args([
                "-hide_banner",
                "-nostdin",
                "-y",
                "-loglevel",
                "error",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
            ])
            .arg(&list)
            .args(["-map", "0:v:0", "-map", "0:a:0?", "-c:v", "copy"]);
        if mixed_audio {
            // Lossless intermediate audio avoids accumulating a new encoder
            // delay each time the microphone changes. Encode the final track once.
            command.args(["-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2"]);
        } else {
            command.args(["-c:a", "copy"]);
        }
        let merged = command
            .args(["-movflags", "+faststart"])
            .arg(&output)
            .output()
            .map_err(|e| e.to_string())?;
        if !merged.status.success() {
            return Err(format!(
                "合并录屏失败，录制片段仍保留。{}",
                String::from_utf8_lossy(&merged.stderr)
            ));
        }
        store
            .recording_store()?
            .import(runtime, &output, Some("屏幕录制.mp4"))
    }
    pub fn abort(&mut self) {
        if let Some(mut active) = self.active.take() {
            #[cfg(target_os = "windows")]
            drop(active.border.take());
            let _ = active.child.kill();
            let _ = active.child.wait();
        }
        self.state = "idle".into();
        self.workspace = None;
        self.options = None;
        self.source = None;
        self.segments.clear();
        self.elapsed = 0.0;
        self.error = None;
        self.muted = false;
    }
}
struct RecordingSegmentInfo {
    audio: bool,
    duration: f64,
}
fn recording_segment_info(runtime: &Runtime, path: &Path) -> Result<RecordingSegmentInfo> {
    let output = process(&runtime.probe)
        .args([
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,duration:format=duration",
            "-of",
            "json",
        ])
        .arg(path)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "读取录制片段失败，原片段仍保留。{}",
            tail(&String::from_utf8_lossy(&output.stderr), 800)
        ));
    }
    let info: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("录制片段信息无效：{error}"))?;
    let streams = info["streams"]
        .as_array()
        .ok_or("录制片段中没有可读取的媒体轨道。")?;
    let video = streams
        .iter()
        .find(|stream| stream["codec_type"] == "video")
        .ok_or("录制片段中没有画面，原片段仍保留。")?;
    let seconds = |value: &serde_json::Value| {
        value
            .as_f64()
            .or_else(|| value.as_str()?.parse::<f64>().ok())
            .filter(|value| value.is_finite() && *value > 0.0)
    };
    let duration = seconds(&video["duration"])
        .or_else(|| seconds(&info["format"]["duration"]))
        .ok_or("无法确定录制片段时长，原片段仍保留。")?;
    Ok(RecordingSegmentInfo {
        audio: streams.iter().any(|stream| stream["codec_type"] == "audio"),
        duration,
    })
}
fn normalize_recording_audio(
    runtime: &Runtime,
    root: &Path,
    index: usize,
    path: &Path,
    info: &RecordingSegmentInfo,
) -> Result<PathBuf> {
    let output = root.join(format!("normalized-audio-{index}.mkv"));
    let duration = format!("{:.9}", info.duration);
    let mut command = process(&runtime.encoder);
    command
        .args(["-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-i"])
        .arg(path);
    if !info.audio {
        command.args(["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]);
    }
    command
        .args([
            "-map",
            "0:v:0",
            "-map",
            if info.audio { "0:a:0" } else { "1:a:0" },
            "-c:v",
            "copy",
            "-af",
            &format!("aresample=48000:async=1:first_pts=0,apad,atrim=duration={duration}"),
            "-c:a",
            "flac",
            "-sample_fmt",
            "s16",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-t",
            &duration,
        ])
        .arg(&output);
    let result = command.output().map_err(|error| error.to_string())?;
    if !result.status.success() {
        return Err(format!(
            "处理麦克风切换片段失败，原片段仍保留。{}",
            tail(&String::from_utf8_lossy(&result.stderr), 1000)
        ));
    }
    Ok(output)
}
fn preflight_microphone(runtime: &Runtime, device: &str, cancelled: &AtomicBool) -> Result<()> {
    check_cancelled(cancelled)?;
    #[cfg(target_os = "macos")]
    let command = {
        let _ = runtime;
        let mut command = crate::capture_service::command()?;
        command.args(["microphone", device]);
        command
    };
    #[cfg(target_os = "windows")]
    let command = {
        let mut command = process(&runtime.encoder);
        command.args([
            "-hide_banner",
            "-nostdin",
            "-loglevel",
            "error",
            "-f",
            "dshow",
            "-i",
            &format!("audio={device}"),
            "-t",
            "0.1",
            "-vn",
            "-f",
            "null",
            "-",
        ]);
        command
    };
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let (status, _, errors) = run_source_listing(command, cancelled, Duration::from_secs(120))?;
        if !status.success() {
            return Err(format!(
                "无法开启麦克风，当前录制保持原设置。{}",
                tail(&String::from_utf8_lossy(&errors), 1000)
            ));
        }
        check_cancelled(cancelled)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (runtime, device);
        Err("当前系统暂不支持原生麦克风录制。".into())
    }
}
fn mute_command(muted: bool, native_helper: bool) -> &'static [u8] {
    match (native_helper, muted) {
        (true, true) => b"mute\n",
        (true, false) => b"unmute\n",
        (false, true) => b"cvolume@capture_volume -1 volume 0\n",
        (false, false) => b"cvolume@capture_volume -1 volume 1\n",
    }
}
fn tail(text: &str, max: usize) -> String {
    text.chars()
        .rev()
        .take(max)
        .collect::<String>()
        .chars()
        .rev()
        .collect()
}
fn stop_child(child: &mut Child, timeout: Duration) -> bool {
    if let Some(input) = child.stdin.as_mut() {
        let _ = input.write_all(b"q\n");
        let _ = input.flush();
    }
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(40)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}
fn wait_until_ready(
    child: &mut Child,
    progress: &Path,
    error_file: &Path,
    helper: bool,
    cancelled: &AtomicBool,
) -> Result<()> {
    let mut stage = String::new();
    let mut deadline = Instant::now() + Duration::from_secs(20);
    loop {
        check_cancelled(cancelled)?;
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            return Err(format!(
                "无法开始录屏（{status}）。{}",
                tail(&fs::read_to_string(error_file).unwrap_or_default(), 1200)
            ));
        }
        let progress = fs::read_to_string(progress).unwrap_or_default();
        if helper {
            if let Some(current) = helper_stage(&progress) {
                if current != stage {
                    stage = current.into();
                    deadline = Instant::now() + helper_stage_timeout(current);
                }
            }
        }
        let ready = if helper {
            progress.lines().any(|line| line.trim() == "READY")
        } else {
            progress
                .lines()
                .filter_map(|line| line.strip_prefix("frame="))
                .any(|frame| frame.trim().parse::<u64>().unwrap_or(0) > 0)
        };
        if ready {
            return Ok(());
        }
        if Instant::now() >= deadline {
            let message = match stage.as_str() {
                "sources" => "等待屏幕录制授权超时。请完成系统授权；若权限已经开启，请完全退出应用后从应用程序目录重新打开，再次选择录制范围。",
                "microphone" => "等待麦克风授权或设备启动超时，请完成系统授权或关闭麦克风录制。",
                "encoder" => "创建录制文件超时，请降低输出尺寸后重新开始。",
                "indicator" => "系统未能登记录制指示框，请重新选择录制范围。",
                "stream" => "启动屏幕采集超时，请重新选择可见的屏幕或窗口；若刚修改权限，请完全退出并重新打开应用。",
                _ => "未收到可编码的录制画面，请检查所选窗口是否可见，并尝试较小的输出尺寸。",
            };
            return Err(format!(
                "{message}{}",
                tail(&fs::read_to_string(error_file).unwrap_or_default(), 1200)
            ));
        }
        thread::sleep(Duration::from_millis(40));
    }
}
fn helper_stage(progress: &str) -> Option<&str> {
    progress.lines().rev().find_map(|line| {
        let stage = line.strip_prefix("STAGE ")?.trim();
        matches!(
            stage,
            "sources" | "microphone" | "encoder" | "indicator" | "stream" | "frame"
        )
        .then_some(stage)
    })
}
fn helper_stage_timeout(stage: &str) -> Duration {
    Duration::from_secs(match stage {
        "sources" | "microphone" => 120,
        _ => 20,
    })
}
fn select_audio_device<'a>(
    devices: &'a [CaptureDevice],
    requested: Option<&str>,
) -> Result<&'a CaptureDevice> {
    match requested.filter(|id| !id.is_empty()) {
        Some(id) => devices
            .iter()
            .find(|device| device.kind == "audio" && device.id == id)
            .ok_or_else(|| "所选麦克风已断开，请重新选择或关闭麦克风录制。".into()),
        None => devices
            .iter()
            .find(|device| device.kind == "audio")
            .ok_or_else(|| "未找到可用麦克风，请连接输入设备或关闭麦克风录制。".into()),
    }
}

fn prepare_audio_choice(devices: &[CaptureDevice], options: &mut CaptureOptions) -> Result<()> {
    options.audio_device = options.audio_device.take().filter(|id| !id.is_empty());
    if options.microphone {
        options.audio_device = Some(
            select_audio_device(devices, options.audio_device.as_deref())?
                .id
                .clone(),
        );
    }
    // Keep an explicitly selected input even while disabled. Enabling it later
    // validates the same device rather than silently switching microphones.
    Ok(())
}

fn select_source(devices: &[CaptureDevice], options: &CaptureOptions) -> Result<CaptureDevice> {
    let selected = options
        .source_id
        .as_deref()
        .or(options.screen_id.as_deref())
        .filter(|s| !s.is_empty());
    let source = match selected {
        Some(id) => devices
            .iter()
            .find(|d| d.id == id && (d.kind == "screen" || d.kind == "window")),
        None => devices.iter().find(|d| d.kind == "screen"),
    };
    source
        .cloned()
        .ok_or_else(|| "所选录制窗口或屏幕已不可用，请刷新并重新选择。".into())
}
fn resolve_output(source: &CaptureDevice, options: &CaptureOptions) -> Result<OutputSize> {
    let width = source
        .width
        .filter(|n| *n > 0)
        .ok_or("无法读取录制源宽度，请重新选择。")?;
    let height = source
        .height
        .filter(|n| *n > 0)
        .ok_or("无法读取录制源高度，请重新选择。")?;
    let (width, height) = if let Some(region) = options.region.as_ref() {
        if source.kind != "screen" {
            return Err("自定义录制区域只适用于屏幕；窗口会完整录制所选窗口。".into());
        }
        if region.x < 0
            || region.y < 0
            || region.width < 16
            || region.height < 16
            || u64::from(region.x as u32) + u64::from(region.width) > u64::from(width)
            || u64::from(region.y as u32) + u64::from(region.height) > u64::from(height)
        {
            return Err("录制区域必须完整位于所选屏幕内，且宽高至少为 16 像素。".into());
        }
        (region.width, region.height)
    } else {
        (width, height)
    };
    let output = options.output_size.unwrap_or_else(|| {
        let factor = 1.0f64
            .min(7680.0 / f64::from(width))
            .min(4320.0 / f64::from(height));
        OutputSize {
            width: ((f64::from(width) * factor).floor() as u32) / 2 * 2,
            height: ((f64::from(height) * factor).floor() as u32) / 2 * 2,
        }
    });
    if output.width < 16
        || output.height < 16
        || output.width > 7680
        || output.height > 4320
        || output.width % 2 != 0
        || output.height % 2 != 0
    {
        return Err("输出宽高须为偶数，宽度 16–7680、高度 16–4320 像素。".into());
    }
    Ok(output)
}
#[cfg(any(target_os = "windows", test))]
fn output_filter(size: OutputSize, fps: u32) -> String {
    format!("scale={}:{}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad={}:{}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={fps}", size.width, size.height, size.width, size.height)
}
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn unsupported_capture() -> Result<std::process::Command> {
    Err("当前平台请使用网页录屏入口。桌面录屏支持 Windows 和 macOS。".into())
}
#[cfg(target_os = "windows")]
fn windows_region(region: Option<&Region>) -> Option<crate::capture_windows::CaptureBounds> {
    region.map(|r| crate::capture_windows::CaptureBounds {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
    })
}
#[cfg(target_os = "windows")]
fn from_windows(target: crate::capture_windows::VisualTarget) -> CaptureDevice {
    CaptureDevice {
        id: target.id,
        name: target.name,
        kind: target.kind,
        width: Some(target.bounds.width),
        height: Some(target.bounds.height),
        bounds: Some(CaptureBounds {
            x: f64::from(target.bounds.x),
            y: f64::from(target.bounds.y),
            width: f64::from(target.bounds.width),
            height: f64::from(target.bounds.height),
        }),
        scale_factor: Some(target.scale_factor),
    }
}
fn resolve_source(runtime: &Runtime, id: &str, cancelled: &AtomicBool) -> Result<CaptureDevice> {
    check_cancelled(cancelled)?;
    #[cfg(target_os = "windows")]
    {
        let _ = runtime;
        return crate::capture_windows::resolve_target(id).map(from_windows);
    }
    #[cfg(not(target_os = "windows"))]
    {
        list_devices_with_permission(runtime, true, cancelled)?
            .into_iter()
            .find(|d| d.id == id && (d.kind == "window" || d.kind == "screen"))
            .ok_or_else(|| "所选窗口或屏幕已不可用，请恢复窗口后继续录制。".into())
    }
}
pub fn list_devices(runtime: &Runtime) -> Result<Vec<CaptureDevice>> {
    list_devices_with_permission(runtime, false, &AtomicBool::new(false))
}
pub fn list_devices_with_resource(
    runtime: &Runtime,
    resource: &Path,
    request_permission: bool,
) -> Result<Vec<CaptureDevice>> {
    list_devices_with_resource_cancellable(
        runtime,
        resource,
        request_permission,
        &AtomicBool::new(false),
    )
}
pub fn list_devices_with_resource_cancellable(
    runtime: &Runtime,
    _resource: &Path,
    request_permission: bool,
    cancelled: &AtomicBool,
) -> Result<Vec<CaptureDevice>> {
    list_devices_with_permission(runtime, request_permission, cancelled)
}
fn list_devices_with_permission(
    runtime: &Runtime,
    request_permission: bool,
    cancelled: &AtomicBool,
) -> Result<Vec<CaptureDevice>> {
    check_cancelled(cancelled)?;
    #[cfg(target_os = "macos")]
    {
        let _ = runtime;
        return list_native_sources(request_permission, cancelled);
    }
    #[cfg(target_os = "windows")]
    {
        let _ = request_permission;
        let mut devices = crate::capture_windows::list_targets()?
            .into_iter()
            .map(from_windows)
            .collect::<Vec<_>>();
        let mut command = process(&runtime.encoder);
        command.args([
            "-hide_banner",
            "-list_devices",
            "true",
            "-f",
            "dshow",
            "-i",
            "dummy",
        ]);
        let (_, _, stderr) = run_source_listing(command, cancelled, Duration::from_secs(25))?;
        devices.extend(parse_devices(&String::from_utf8_lossy(&stderr), false));
        return Ok(devices);
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = (runtime, request_permission);
        Ok(vec![])
    }
}
#[cfg(target_os = "macos")]
fn list_native_sources(
    request_permission: bool,
    cancelled: &AtomicBool,
) -> Result<Vec<CaptureDevice>> {
    let mut command = crate::capture_service::command()?;
    command.arg("sources");
    if request_permission {
        command.arg("--request-permission");
    }
    let timeout = Duration::from_secs(if request_permission { 120 } else { 25 });
    let (status, stdout, stderr) = run_source_listing(command, cancelled, timeout)?;
    if !status.success() {
        return Err(format!(
            "无法读取录制窗口。{}",
            tail(&String::from_utf8_lossy(&stderr), 1000)
        ));
    }
    serde_json::from_slice(&stdout).map_err(|e| format!("录制窗口列表无效：{e}"))
}
#[cfg(any(target_os = "windows", target_os = "macos", test))]
fn run_source_listing(
    mut command: std::process::Command,
    cancelled: &AtomicBool,
    timeout: Duration,
) -> Result<(std::process::ExitStatus, Vec<u8>, Vec<u8>)> {
    check_cancelled(cancelled)?;
    let root = tempfile::tempdir().map_err(|e| e.to_string())?;
    let stdout = root.path().join("sources.json");
    let stderr = root.path().join("sources.log");
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::from(
            fs::File::create(&stdout).map_err(|e| e.to_string())?,
        ))
        .stderr(Stdio::from(
            fs::File::create(&stderr).map_err(|e| e.to_string())?,
        ))
        .spawn()
        .map_err(|e| format!("无法读取录制设备：{e}"))?;
    let deadline = Instant::now() + timeout;
    loop {
        if let Err(error) = check_cancelled(cancelled) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                return Ok((
                    status,
                    fs::read(&stdout).map_err(|e| e.to_string())?,
                    fs::read(&stderr).map_err(|e| e.to_string())?,
                ))
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error.to_string());
            }
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(40)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "等待录制来源或系统授权超时，请完成授权后重新选择；若权限已经开启，请完全退出并重新打开应用。{}",
                    tail(&String::from_utf8_lossy(&fs::read(&stderr).unwrap_or_default()), 1000)
                ));
            }
        }
    }
}
pub fn parse_devices(text: &str, mac: bool) -> Vec<CaptureDevice> {
    let mut result = Vec::new();
    let mut audio = false;
    for line in text.lines() {
        if mac {
            if line.contains("audio devices:") {
                audio = true;
                continue;
            }
            if line.contains("video devices:") {
                audio = false;
                continue;
            }
            let Some((_, tail)) = line.split_once("] ") else {
                continue;
            };
            let Some(tail) = tail.strip_prefix('[') else {
                continue;
            };
            let Some((id, name)) = tail.split_once("] ") else {
                continue;
            };
            if !id.chars().all(|c| c.is_ascii_digit()) {
                continue;
            }
            if audio || name.to_lowercase().contains("screen") {
                result.push(CaptureDevice {
                    id: id.into(),
                    name: name.into(),
                    kind: if audio { "audio" } else { "screen" }.into(),
                    ..CaptureDevice::default()
                });
            }
        } else if line.contains("(audio)") {
            if let Some(start) = line.find('"') {
                if let Some(end) = line[start + 1..].find('"') {
                    let name = &line[start + 1..start + 1 + end];
                    result.push(CaptureDevice {
                        id: name.into(),
                        name: name.into(),
                        kind: "audio".into(),
                        ..CaptureDevice::default()
                    });
                }
            }
        }
    }
    result
}

#[cfg(test)]
mod capture_tests {
    use super::*;
    #[test]
    fn helper_progress_distinguishes_permission_wait_from_missing_frames() {
        assert_eq!(helper_stage("STAGE sources\n"), Some("sources"));
        assert_eq!(
            helper_stage("STAGE sources\nSTAGE encoder\nSTAGE frame\nREADY\n"),
            Some("frame")
        );
        assert_eq!(helper_stage("READY\n"), None);
        assert_eq!(helper_stage("STAGE unsupported\n"), None);
        assert_eq!(helper_stage_timeout("sources"), Duration::from_secs(120));
        assert_eq!(helper_stage_timeout("microphone"), Duration::from_secs(120));
        assert_eq!(helper_stage_timeout("frame"), Duration::from_secs(20));
    }
    fn source(kind: &str, width: u32, height: u32) -> CaptureDevice {
        CaptureDevice {
            id: format!("{kind}:selected"),
            name: "测试录制源".into(),
            kind: kind.into(),
            width: Some(width),
            height: Some(height),
            ..CaptureDevice::default()
        }
    }
    fn options() -> CaptureOptions {
        CaptureOptions {
            request_id: None,
            fps: 25,
            microphone: false,
            source_id: None,
            screen_id: None,
            audio_device: None,
            region: None,
            output_size: None,
        }
    }
    #[test]
    fn explicit_audio_input_never_falls_back_to_another_microphone() {
        let default = source("audio", 0, 0);
        let mut selected = default.clone();
        selected.id = "selected-usb-input".into();
        let devices = vec![
            source("screen", 1920, 1080),
            default.clone(),
            selected.clone(),
        ];
        assert_eq!(select_audio_device(&devices, None).unwrap().id, default.id);
        assert_eq!(
            select_audio_device(&devices, Some("")).unwrap().id,
            default.id
        );
        assert_eq!(
            select_audio_device(&devices, Some(&selected.id))
                .unwrap()
                .id,
            selected.id
        );
        assert!(select_audio_device(&devices, Some("missing-input"))
            .unwrap_err()
            .contains("已断开"));
        assert!(select_audio_device(&devices, Some("screen:selected")).is_err());
    }

    #[test]
    fn disabled_audio_retains_the_exact_input_for_later_activation() {
        let mut requested = options();
        requested.audio_device = Some("temporarily-disconnected-input".into());
        let devices = vec![source("audio", 0, 0)];
        prepare_audio_choice(&devices, &mut requested).unwrap();
        assert_eq!(
            requested.audio_device.as_deref(),
            Some("temporarily-disconnected-input")
        );
        requested.microphone = true;
        assert!(prepare_audio_choice(&devices, &mut requested)
            .unwrap_err()
            .contains("已断开"));
        assert_eq!(
            requested.audio_device.as_deref(),
            Some("temporarily-disconnected-input")
        );
        requested.audio_device = Some(String::new());
        prepare_audio_choice(&devices, &mut requested).unwrap();
        assert_eq!(requested.audio_device.as_deref(), Some("audio:selected"));
    }
    #[test]
    fn mute_preserves_paused_state_and_never_enables_an_unrequested_device() {
        let mut manager = CaptureManager::default();
        assert!(manager.set_muted(true).is_err());
        manager.options = Some(options());
        manager.state = "paused".into();
        manager.elapsed = 12.5;
        assert!(!manager.status().audio_available);
        assert!(manager.set_muted(true).is_err());
        manager.options.as_mut().unwrap().microphone = true;
        let muted = manager.set_muted(true).unwrap();
        assert!(muted.muted && muted.audio_available);
        assert_eq!(muted.state, "paused");
        assert_eq!(muted.elapsed, 12.5);
        assert!(!manager.set_muted(false).unwrap().muted);
        manager.set_muted(true).unwrap();
        manager.abort();
        let idle = manager.status();
        assert!(!idle.muted && !idle.audio_available);
    }
    #[test]
    fn mute_commands_address_only_the_recording_audio_filter() {
        assert_eq!(mute_command(true, true), b"mute\n");
        assert_eq!(mute_command(false, true), b"unmute\n");
        assert_eq!(
            mute_command(true, false),
            b"cvolume@capture_volume -1 volume 0\n"
        );
        assert_eq!(
            mute_command(false, false),
            b"cvolume@capture_volume -1 volume 1\n"
        );
    }
    #[test]
    fn microphone_changes_preserve_paused_time_and_cancellation_preserves_the_device() {
        let mut manager = CaptureManager::default();
        assert!(manager.set_microphone_enabled(false).is_err());
        manager.state = "paused".into();
        manager.options = Some(options());
        manager.options.as_mut().unwrap().microphone = true;
        manager.options.as_mut().unwrap().audio_device = Some("selected-microphone".into());
        manager.elapsed = 14.25;
        assert!(manager
            .set_microphone_enabled_cancellable(false, &AtomicBool::new(true))
            .is_err());
        assert!(manager.status().microphone_enabled);
        let status = manager.set_microphone_enabled(false).unwrap();
        assert!(!status.microphone_enabled && !status.audio_available);
        assert_eq!(status.state, "paused");
        assert_eq!(status.elapsed, 14.25);
        assert_eq!(
            manager.options.as_ref().unwrap().audio_device.as_deref(),
            Some("selected-microphone")
        );
        let status = manager
            .switch_microphone(
                true,
                Some("selected-microphone".into()),
                &AtomicBool::new(false),
                |_, _| {
                    panic!("Changing a paused recording must not start video or hold a microphone")
                },
            )
            .unwrap();
        assert!(status.microphone_enabled);
        assert_eq!(status.state, "paused");
        assert_eq!(status.elapsed, 14.25);
        manager.abort();
        assert!(!manager.status().microphone_enabled);
    }
    #[test]
    fn failed_microphone_enable_restores_the_original_recording_and_retains_segments() {
        let mut manager = CaptureManager::default();
        manager.state = "recording".into();
        manager.options = Some(options());
        manager.elapsed = 8.5;
        manager.segments.push(PathBuf::from("already-saved.mp4"));
        let mut attempts = 0;
        let error = manager
            .switch_microphone(
                true,
                Some("unplugged".into()),
                &AtomicBool::new(false),
                |manager, recovery| {
                    attempts += 1;
                    if !recovery {
                        assert!(manager.options.as_ref().unwrap().microphone);
                        Err("设备已断开".into())
                    } else {
                        assert!(!manager.options.as_ref().unwrap().microphone);
                        manager.state = "recording".into();
                        Ok(())
                    }
                },
            )
            .err()
            .unwrap();
        assert!(error.contains("已按原设置继续录制"));
        assert_eq!(attempts, 2);
        let status = manager.status();
        assert_eq!(status.state, "recording");
        assert!(!status.microphone_enabled);
        assert_eq!(status.elapsed, 8.5);
        assert_eq!(manager.segments, [PathBuf::from("already-saved.mp4")]);
        let error = manager
            .switch_microphone(
                true,
                Some("unplugged".into()),
                &AtomicBool::new(false),
                |_, _| Err("来源已关闭".into()),
            )
            .err()
            .unwrap();
        assert!(error.contains("录制已暂停"));
        assert_eq!(manager.status().state, "paused");
        assert_eq!(manager.segments.len(), 1);
    }
    #[test]
    fn failed_video_restart_after_microphone_disable_never_reopens_the_microphone() {
        let mut manager = CaptureManager::default();
        manager.state = "recording".into();
        manager.options = Some(options());
        manager.options.as_mut().unwrap().microphone = true;
        let mut attempts = 0;
        let error = manager
            .switch_microphone(false, None, &AtomicBool::new(false), |manager, recovery| {
                attempts += 1;
                assert!(!recovery);
                assert!(!manager.options.as_ref().unwrap().microphone);
                Err("窗口已关闭".into())
            })
            .err()
            .unwrap();
        assert!(error.contains("麦克风已关闭"));
        assert_eq!(attempts, 1);
        assert_eq!(manager.status().state, "paused");
        assert!(!manager.status().microphone_enabled);
    }
    #[test]
    fn cancelling_during_microphone_switch_skips_recovery_and_retains_saved_segments() {
        let mut manager = CaptureManager::default();
        manager.state = "recording".into();
        manager.options = Some(options());
        manager
            .segments
            .push(PathBuf::from("saved-before-toggle.mp4"));
        let cancelled = AtomicBool::new(false);
        let mut attempts = 0;
        let error = manager
            .switch_microphone(
                true,
                Some("microphone".into()),
                &cancelled,
                |_, recovery| {
                    attempts += 1;
                    assert!(
                        !recovery,
                        "A cancelled microphone change must not reopen the previous capture"
                    );
                    cancelled.store(true, Ordering::SeqCst);
                    check_cancelled(&cancelled)
                },
            )
            .err()
            .unwrap();
        assert_eq!(error, "录制已取消。");
        assert_eq!(attempts, 1);
        assert_eq!(manager.status().state, "paused");
        assert!(!manager.status().microphone_enabled);
        assert_eq!(manager.segments, [PathBuf::from("saved-before-toggle.mp4")]);
    }
    #[test]
    fn cancelling_during_microphone_recovery_does_not_try_another_capture() {
        let mut manager = CaptureManager::default();
        manager.state = "recording".into();
        manager.options = Some(options());
        manager
            .segments
            .push(PathBuf::from("saved-before-toggle.mp4"));
        let cancelled = AtomicBool::new(false);
        let mut attempts = 0;
        let error = manager
            .switch_microphone(
                true,
                Some("microphone".into()),
                &cancelled,
                |_, recovery| {
                    attempts += 1;
                    if recovery {
                        cancelled.store(true, Ordering::SeqCst);
                        check_cancelled(&cancelled)
                    } else {
                        Err("麦克风设备已断开".into())
                    }
                },
            )
            .err()
            .unwrap();
        assert!(error.contains("录制已取消"));
        assert_eq!(attempts, 2);
        assert_eq!(manager.status().state, "paused");
        assert!(!manager.status().microphone_enabled);
        assert_eq!(manager.segments.len(), 1);
    }
    #[test]
    fn selection_never_substitutes_another_window_or_screen() {
        let devices = vec![source("screen", 1920, 1080), source("window", 800, 600)];
        let mut options = options();
        assert_eq!(select_source(&devices, &options).unwrap().kind, "screen");
        options.source_id = Some("window:closed".into());
        assert!(select_source(&devices, &options).is_err());
        options.screen_id = Some(devices[0].id.clone());
        assert!(
            select_source(&devices, &options).is_err(),
            "Explicit source must not fall back to old screen selection"
        );
        options.source_id = Some(devices[1].id.clone());
        assert_eq!(select_source(&devices, &options).unwrap().kind, "window");
    }
    #[test]
    fn regions_are_screen_relative_and_cannot_escape_screen_bounds() {
        let screen = source("screen", 1920, 1080);
        let mut options = options();
        options.region = Some(Region {
            x: 1720,
            y: 980,
            width: 200,
            height: 100,
        });
        assert_eq!(
            resolve_output(&screen, &options).unwrap(),
            OutputSize {
                width: 200,
                height: 100
            }
        );
        assert!(resolve_output(&source("window", 1920, 1080), &options).is_err());
        options.region.as_mut().unwrap().x = 1721;
        assert!(resolve_output(&screen, &options).is_err());
        options.region.as_mut().unwrap().x = -1;
        assert!(resolve_output(&screen, &options).is_err());
        options.region.as_mut().unwrap().x = i32::MAX;
        options.region.as_mut().unwrap().width = u32::MAX;
        assert!(resolve_output(&screen, &options).is_err());
    }
    #[test]
    fn dimensions_remain_fixed_after_source_resize_and_reject_invalid_outputs() {
        let mut options = options();
        let size = resolve_output(&source("window", 901, 701), &options).unwrap();
        assert_eq!(
            size,
            OutputSize {
                width: 900,
                height: 700
            }
        );
        options.output_size = Some(size);
        assert_eq!(
            resolve_output(&source("window", 1200, 800), &options).unwrap(),
            size
        );
        options.output_size = Some(OutputSize {
            width: 901,
            height: 701,
        });
        assert!(resolve_output(&source("window", 1200, 800), &options).is_err());
        options.output_size = Some(OutputSize {
            width: 7682,
            height: 4320,
        });
        assert!(resolve_output(&source("window", 1200, 800), &options).is_err());
        options.output_size = None;
        assert_eq!(
            resolve_output(&source("screen", 15360, 8640), &options).unwrap(),
            OutputSize {
                width: 7680,
                height: 4320
            }
        );
    }
    #[test]
    fn cancellation_before_start_is_not_reset_and_queries_release_real_processes() {
        let runtime = Runtime::discover(None, None).expect("Media runtime required");
        let registry = CaptureStartCancellation::default();
        let id = "018f9ec0-f0e7-4b5d-9569-2eae6aa3e605";
        registry.cancel(id).unwrap();
        let cancelled = registry.token(id).unwrap();
        let mut manager = CaptureManager::default();
        let error = manager
            .start_cancellable(&runtime, options(), &cancelled)
            .err()
            .unwrap();
        assert_eq!(error, "录制已取消。");
        assert!(manager.active.is_none() && manager.workspace.is_none());
        assert_eq!(manager.state, "idle");
        registry.complete(id);
        assert!(registry.tokens.lock().unwrap().is_empty());
        let root = tempfile::tempdir().unwrap();
        let output = root.path().join("cancelled.mkv");
        let cancelled = Arc::new(AtomicBool::new(false));
        let token = cancelled.clone();
        let encoder = runtime.encoder.clone();
        let child_output = output.clone();
        let worker = thread::spawn(move || {
            let mut command = process(&encoder);
            command
                .args([
                    "-hide_banner",
                    "-y",
                    "-loglevel",
                    "error",
                    "-re",
                    "-f",
                    "lavfi",
                    "-i",
                    "color=c=red:s=160x120:r=20:d=10",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "ultrafast",
                ])
                .arg(child_output);
            run_source_listing(command, &token, Duration::from_secs(25))
        });
        let deadline = Instant::now() + Duration::from_secs(3);
        while !output.exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(
            output.exists(),
            "The real process must start before cancellation"
        );
        let stopped = Instant::now();
        cancelled.store(true, Ordering::SeqCst);
        assert_eq!(worker.join().unwrap().err().unwrap(), "录制已取消。");
        assert!(
            stopped.elapsed() < Duration::from_secs(2),
            "Cancellation must release the query process promptly"
        );
        // A process retaining the output handle prevents this rename on the desktop platform.
        fs::rename(&output, root.path().join("released.mkv")).unwrap();
    }
    #[test]
    fn recording_readiness_requires_encoded_frames_and_stop_releases_encoder() {
        let runtime = Runtime::discover(None, None).expect("Media runtime required");
        let root = tempfile::tempdir().unwrap();
        let ready = root.path().join("ready.txt");
        let errors = root.path().join("error.log");
        let video = root.path().join("capture.mkv");
        let mut child = process(&runtime.encoder)
            .args([
                "-hide_banner",
                "-y",
                "-loglevel",
                "error",
                "-re",
                "-f",
                "lavfi",
                "-i",
                "color=c=red:s=160x120:r=20:d=3",
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-pix_fmt",
                "yuv420p",
                "-stats_period",
                "0.1",
                "-progress",
            ])
            .arg(&ready)
            .arg(&video)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::from(fs::File::create(&errors).unwrap()))
            .spawn()
            .unwrap();
        wait_until_ready(&mut child, &ready, &errors, false, &AtomicBool::new(false)).unwrap();
        assert!(stop_child(&mut child, Duration::from_secs(3)));
        assert!(child.try_wait().unwrap().is_some());
        let mut capture = CaptureManager::default();
        capture.runtime = Some(runtime.clone());
        assert!(
            capture.recoverable(&video),
            "Readiness must correspond to an actual playable video"
        );
        let mut failed = process(&runtime.encoder)
            .args([
                "-hide_banner",
                "-f",
                "not-a-capture-device",
                "-i",
                "invalid",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::from(fs::File::create(&errors).unwrap()))
            .spawn()
            .unwrap();
        let error = wait_until_ready(
            &mut failed,
            &root.path().join("never-ready"),
            &errors,
            false,
            &AtomicBool::new(false),
        )
        .unwrap_err();
        assert!(
            error.contains("not-a-capture-device"),
            "The actual encoder error must survive: {error}"
        );
        stop_child(&mut failed, Duration::from_secs(1));
        assert!(failed.try_wait().unwrap().is_some());
    }
    #[test]
    fn mixed_microphone_segments_keep_audio_and_silence_at_the_original_video_times() {
        let runtime = Runtime::discover(None, None).expect("Media runtime required");
        let root = tempfile::tempdir().unwrap();
        let store = MediaStore::new(root.path()).unwrap();
        for initially_enabled in [false, true] {
            let mut capture = CaptureManager::default();
            capture.runtime = Some(runtime.clone());
            capture.workspace = Some(tempfile::tempdir().unwrap());
            capture.state = "paused".into();
            for index in 0..4 {
                let enabled = (index % 2 == 0) == initially_enabled;
                let path = capture
                    .workspace
                    .as_ref()
                    .unwrap()
                    .path()
                    .join(format!("segment-{index}.mp4"));
                let mut command = process(&runtime.encoder);
                command.args([
                    "-hide_banner",
                    "-nostdin",
                    "-y",
                    "-loglevel",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "color=c=red:s=160x120:r=25:d=0.8",
                ]);
                if enabled {
                    command.args([
                        "-f",
                        "lavfi",
                        "-i",
                        "sine=frequency=440:sample_rate=48000:duration=0.8",
                        "-c:a",
                        "aac",
                        "-ar",
                        "48000",
                        "-ac",
                        "2",
                    ]);
                }
                let result = command
                    .args([
                        "-c:v",
                        "libx264",
                        "-preset",
                        "ultrafast",
                        "-pix_fmt",
                        "yuv420p",
                    ])
                    .arg(&path)
                    .output()
                    .unwrap();
                assert!(
                    result.status.success(),
                    "{}",
                    String::from_utf8_lossy(&result.stderr)
                );
                capture.segments.push(path);
            }
            let asset = capture.stop(&store).unwrap().unwrap();
            let info = recording_segment_info(&runtime, Path::new(&asset.native_path)).unwrap();
            assert!(info.audio);
            assert!(
                (info.duration - 3.2).abs() < 0.05,
                "Microphone changes must not stretch the video: {}",
                info.duration
            );
            let decoded = process(&runtime.encoder)
                .args(["-hide_banner", "-loglevel", "error", "-i"])
                .arg(&asset.native_path)
                .args(["-vn", "-ar", "48000", "-ac", "1", "-f", "f32le", "pipe:1"])
                .output()
                .unwrap();
            assert!(
                decoded.status.success(),
                "{}",
                String::from_utf8_lossy(&decoded.stderr)
            );
            let samples = decoded
                .stdout
                .chunks_exact(4)
                .map(|bytes| f32::from_le_bytes(bytes.try_into().unwrap()))
                .collect::<Vec<_>>();
            assert!(samples.len() >= 3 * 48000);
            for index in 0..4 {
                let enabled = (index % 2 == 0) == initially_enabled;
                let start = ((index as f64 * 0.8 + 0.2) * 48000.0) as usize;
                let end = start + 4800;
                let rms = (samples[start..end]
                    .iter()
                    .map(|sample| (*sample as f64).powi(2))
                    .sum::<f64>()
                    / (end - start) as f64)
                    .sqrt();
                assert!(if enabled { rms > 0.03 } else { rms < 0.0001 }, "Wrong audio after microphone change: initial={initially_enabled}, segment={index}, rms={rms}");
            }
            let probe = process(&runtime.probe)
                .args([
                    "-v",
                    "error",
                    "-select_streams",
                    "v:0",
                    "-count_frames",
                    "-show_entries",
                    "stream=nb_read_frames",
                    "-of",
                    "csv=p=0",
                ])
                .arg(&asset.native_path)
                .output()
                .unwrap();
            assert!(probe.status.success());
            assert_eq!(
                String::from_utf8_lossy(&probe.stdout).trim(),
                "80",
                "Every original video frame must survive audio normalization"
            );
        }
    }
    #[test]
    fn resized_recording_segments_have_fixed_pixels_and_merge_as_real_video() {
        let runtime = Runtime::discover(None, None).expect("Media runtime required");
        let root = tempfile::tempdir().unwrap();
        let store = MediaStore::new(root.path()).unwrap();
        let mut capture = CaptureManager::default();
        capture.runtime = Some(runtime.clone());
        capture.workspace = Some(tempfile::tempdir().unwrap());
        capture.state = "paused".into();
        let size = OutputSize {
            width: 320,
            height: 240,
        };
        for (index, dimensions, color) in [(0, "320x180", "red"), (1, "160x240", "blue")] {
            let path = capture
                .workspace
                .as_ref()
                .unwrap()
                .path()
                .join(format!("segment-{index}.mkv"));
            let output = process(&runtime.encoder)
                .args([
                    "-hide_banner",
                    "-nostdin",
                    "-y",
                    "-loglevel",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    &format!("color=c={color}:s={dimensions}:r=25:d=0.5"),
                    "-vf",
                    &output_filter(size, 25),
                    "-c:v",
                    "libx264",
                    "-preset",
                    "ultrafast",
                    "-pix_fmt",
                    "yuv420p",
                ])
                .arg(&path)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            capture.segments.push(path);
        }
        let unavailable_store = MediaStore {
            root: root.path().join("unavailable"),
        };
        assert!(capture.stop(&unavailable_store).is_err());
        assert_eq!(
            capture.state, "paused",
            "A save failure must remain recoverable"
        );
        assert_eq!(capture.segments.len(), 2);
        assert!(capture.workspace.is_some());
        let asset = capture.stop(&store).unwrap().unwrap();
        let path = asset.native_path.as_str();
        assert_eq!(
            Path::new(path).parent(),
            Some(store.recording_root().unwrap().as_path())
        );
        assert_eq!(
            fs::read_dir(&store.root).unwrap().count(),
            0,
            "Recording must not populate the editing media store"
        );
        assert_eq!(
            store
                .authorized_path(&serde_json::to_value(&asset).unwrap())
                .unwrap(),
            Path::new(path)
        );
        let output = process(&runtime.probe)
            .args([
                "-v",
                "error",
                "-show_entries",
                "stream=width,height",
                "-of",
                "json",
            ])
            .arg(path)
            .output()
            .unwrap();
        let info: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(info["streams"][0]["width"], 320);
        assert_eq!(info["streams"][0]["height"], 240);
        let output = process(&runtime.encoder)
            .args(["-hide_banner", "-loglevel", "error", "-i"])
            .arg(path)
            .args(["-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"])
            .output()
            .unwrap();
        assert!(output.status.success());
        let frames = output
            .stdout
            .chunks_exact(320 * 240 * 3)
            .collect::<Vec<_>>();
        assert!(frames.len() >= 24, "Both resumed segments must decode");
        let pixel = |frame: &[u8], x: usize, y: usize| -> [u8; 3] {
            frame[(y * 320 + x) * 3..(y * 320 + x) * 3 + 3]
                .try_into()
                .unwrap()
        };
        let first = pixel(frames[2], 160, 120);
        let last = pixel(frames[frames.len() - 2], 160, 120);
        assert!(
            first[0] > 180 && first[1] < 30 && first[2] < 30,
            "First segment must be red: {first:?}"
        );
        assert!(
            last[2] > 180 && last[0] < 30 && last[1] < 30,
            "Second segment must be blue: {last:?}"
        );
        assert!(
            pixel(frames[2], 160, 10).iter().all(|v| *v < 20),
            "Wide source must have top padding"
        );
        assert!(
            pixel(frames[frames.len() - 2], 10, 120)
                .iter()
                .all(|v| *v < 20),
            "Tall source must have side padding"
        );
        assert_eq!(capture.state, "idle");
        assert!(capture.segments.is_empty());
    }
}
