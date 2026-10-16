use crate::engine::{new_id, process, Asset, MediaStore, Result, Runtime};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::PathBuf,
    process::{Child, Stdio},
    thread,
    time::{Duration, Instant},
};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureOptions {
    pub fps: u32,
    pub microphone: bool,
    pub screen_id: Option<String>,
    pub audio_device: Option<String>,
    pub region: Option<Region>,
}
#[derive(Clone, Deserialize)]
pub struct Region {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureDevice {
    pub id: String,
    pub name: String,
    pub kind: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStatus {
    pub state: String,
    pub elapsed: f64,
    pub segments: usize,
    pub error: Option<String>,
}
struct ActiveSegment {
    child: Child,
    path: PathBuf,
    error_file: PathBuf,
    started: Instant,
}
pub struct CaptureManager {
    runtime: Option<Runtime>,
    options: Option<CaptureOptions>,
    workspace: Option<tempfile::TempDir>,
    active: Option<ActiveSegment>,
    segments: Vec<PathBuf>,
    elapsed: f64,
    state: String,
    error: Option<String>,
}
impl Default for CaptureManager {
    fn default() -> Self {
        Self {
            runtime: None,
            options: None,
            workspace: None,
            active: None,
            segments: vec![],
            elapsed: 0.0,
            state: "idle".into(),
            error: None,
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
        if let Some(active) = self.active.as_mut() {
            if let Ok(Some(_)) = active.child.try_wait() {
                let detail = fs::read_to_string(&active.error_file).unwrap_or_default();
                self.elapsed += active.started.elapsed().as_secs_f64();
                let path = active.path.clone();
                self.active = None;
                if self.recoverable(&path) {
                    self.segments.push(path);
                }
                self.state = "paused".into();
                self.error = Some(format!(
                    "录制意外停止。请检查屏幕和麦克风授权。{}",
                    detail
                        .chars()
                        .rev()
                        .take(800)
                        .collect::<String>()
                        .chars()
                        .rev()
                        .collect::<String>()
                ));
            }
        }
        CaptureStatus {
            state: self.state.clone(),
            elapsed: self.elapsed
                + self
                    .active
                    .as_ref()
                    .map(|a| a.started.elapsed().as_secs_f64())
                    .unwrap_or(0.0),
            segments: self.segments.len() + usize::from(self.active.is_some()),
            error: self.error.clone(),
        }
    }
    fn recoverable(&self, path: &std::path::Path) -> bool {
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
        if self.state != "idle" {
            return Err("请先结束当前录制。".into());
        }
        if !(1..=60).contains(&options.fps) {
            return Err("录制帧率应为 1 至 60。".into());
        }
        if let Some(r) = &options.region {
            if r.width < 16 || r.height < 16 || r.width > 7680 || r.height > 4320 {
                return Err("录制区域尺寸无效。".into());
            }
        }
        self.runtime = Some(runtime.clone());
        self.options = Some(options);
        self.workspace = Some(tempfile::tempdir().map_err(|e| e.to_string())?);
        self.segments.clear();
        self.elapsed = 0.0;
        self.error = None;
        if let Err(error) = self.spawn_segment() {
            self.state = "idle".into();
            return Err(error);
        }
        Ok(self.status())
    }
    fn spawn_segment(&mut self) -> Result<()> {
        let runtime = self.runtime.as_ref().ok_or("录制引擎不可用。")?;
        let options = self.options.as_ref().ok_or("录制设置不可用。")?;
        let root = self.workspace.as_ref().ok_or("录制目录不可用。")?.path();
        let id = new_id();
        let output = root.join(format!("{id}.mkv"));
        let error_file = root.join(format!("{id}.log"));
        let stderr = fs::File::create(&error_file).map_err(|e| e.to_string())?;
        let mut command = process(&runtime.encoder);
        command.args(["-hide_banner", "-y", "-loglevel", "warning"]);
        if cfg!(target_os = "windows") {
            command.args([
                "-f",
                "gdigrab",
                "-framerate",
                &options.fps.to_string(),
                "-draw_mouse",
                "1",
            ]);
            if let Some(r) = &options.region {
                command.args([
                    "-offset_x",
                    &r.x.to_string(),
                    "-offset_y",
                    &r.y.to_string(),
                    "-video_size",
                    &format!("{}x{}", r.width, r.height),
                ]);
            }
            command.args(["-i", "desktop"]);
            if options.microphone {
                let device = options
                    .audio_device
                    .clone()
                    .filter(|s| !s.is_empty())
                    .or_else(|| {
                        list_devices(runtime)
                            .ok()?
                            .into_iter()
                            .find(|d| d.kind == "audio")
                            .map(|d| d.id)
                    })
                    .ok_or("未找到麦克风，请连接设备或关闭麦克风录制。")?;
                command.args([
                    "-thread_queue_size",
                    "1024",
                    "-f",
                    "dshow",
                    "-i",
                    &format!("audio={device}"),
                ]);
            }
        } else if cfg!(target_os = "macos") {
            let screen = options
                .screen_id
                .clone()
                .filter(|s| !s.is_empty())
                .or_else(|| {
                    list_devices(runtime)
                        .ok()?
                        .into_iter()
                        .find(|d| d.kind == "screen")
                        .map(|d| d.id)
                })
                .ok_or("未找到可录制屏幕，请在系统设置中允许屏幕录制。")?;
            if !screen.chars().all(|c| c.is_ascii_digit()) {
                return Err("请选择有效的屏幕。".into());
            }
            let audio = if options.microphone {
                options.audio_device.as_deref().unwrap_or("0")
            } else {
                "none"
            };
            if audio != "none" && !audio.chars().all(|c| c.is_ascii_digit()) {
                return Err("请选择有效的麦克风。".into());
            }
            command.args([
                "-f",
                "avfoundation",
                "-framerate",
                &options.fps.to_string(),
                "-capture_cursor",
                "1",
                "-capture_mouse_clicks",
                "1",
                "-i",
                &format!("{screen}:{audio}"),
            ]);
        } else {
            return Err("当前平台请使用网页录屏入口。桌面录屏支持 Windows 和 macOS。".into());
        }
        let crop = if cfg!(target_os = "macos") {
            options
                .region
                .as_ref()
                .map(|r| format!("crop={}:{}:{}:{},", r.width, r.height, r.x, r.y))
                .unwrap_or_default()
        } else {
            String::new()
        };
        command.args([
            "-vf",
            &format!("{crop}scale=trunc(iw/2)*2:trunc(ih/2)*2"),
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
            command.args(["-c:a", "aac", "-b:a", "128k"]);
        } else {
            command.arg("-an");
        }
        command
            .arg(&output)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::from(stderr));
        let mut child = command.spawn().map_err(|e| format!("无法启动录屏：{e}"))?;
        thread::sleep(Duration::from_millis(250));
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            let detail = fs::read_to_string(&error_file).unwrap_or_default();
            return Err(format!(
                "无法开始录屏（{status}）。请允许屏幕或麦克风访问。{}",
                detail.chars().take(1000).collect::<String>()
            ));
        }
        self.active = Some(ActiveSegment {
            child,
            path: output,
            error_file,
            started: Instant::now(),
        });
        self.state = "recording".into();
        self.error = None;
        Ok(())
    }
    fn finish_segment(&mut self) -> Result<()> {
        let Some(mut active) = self.active.take() else {
            return Ok(());
        };
        if let Some(input) = active.child.stdin.as_mut() {
            let _ = input.write_all(b"q\n");
            let _ = input.flush();
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        let result = loop {
            match active.child.try_wait() {
                Ok(Some(status)) => break status.success(),
                Err(_) => break false,
                _ => {
                    if Instant::now() >= deadline {
                        let _ = active.child.kill();
                        let _ = active.child.wait();
                        break false;
                    }
                    thread::sleep(Duration::from_millis(50));
                }
            }
        };
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
    pub fn resume(&mut self) -> Result<CaptureStatus> {
        if self.state != "paused" {
            return Err("当前录制未暂停。".into());
        }
        self.spawn_segment()?;
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
            finish?;
            return Ok(None);
        }
        let runtime = self.runtime.as_ref().ok_or("录制引擎不可用。")?;
        let root = self.workspace.as_ref().unwrap().path();
        let list = root.join("segments.txt");
        let content = self
            .segments
            .iter()
            .map(|p| {
                format!(
                    "file '{}'",
                    p.to_string_lossy()
                        .replace('\\', "/")
                        .replace('\'', "'\\''")
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(&list, content).map_err(|e| e.to_string())?;
        let output = root.join("recording.mp4");
        let merged = process(&runtime.encoder)
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
            .args(["-c", "copy", "-movflags", "+faststart"])
            .arg(&output)
            .output()
            .map_err(|e| e.to_string())?;
        if !merged.status.success() {
            self.state = "paused".into();
            return Err(format!(
                "合并录屏失败，录制片段仍保留。{}",
                String::from_utf8_lossy(&merged.stderr)
            ));
        }
        let imported = store.import(runtime, &output, Some("屏幕录制.mp4"));
        if imported.is_ok() {
            self.state = "idle".into();
            self.workspace = None;
            self.segments.clear();
            self.elapsed = 0.0;
            self.error = None;
        } else {
            self.state = "paused".into();
        }
        imported.map(Some)
    }
    pub fn abort(&mut self) {
        if let Some(active) = self.active.as_mut() {
            let _ = active.child.kill();
            let _ = active.child.wait();
        }
        self.active = None;
        self.state = "idle".into();
    }
}
pub fn list_devices(runtime: &Runtime) -> Result<Vec<CaptureDevice>> {
    if cfg!(target_os = "macos") {
        let out = process(&runtime.encoder)
            .args([
                "-hide_banner",
                "-f",
                "avfoundation",
                "-list_devices",
                "true",
                "-i",
                "",
            ])
            .output()
            .map_err(|e| e.to_string())?;
        Ok(parse_devices(&String::from_utf8_lossy(&out.stderr), true))
    } else if cfg!(target_os = "windows") {
        let out = process(&runtime.encoder)
            .args([
                "-hide_banner",
                "-list_devices",
                "true",
                "-f",
                "dshow",
                "-i",
                "dummy",
            ])
            .output()
            .map_err(|e| e.to_string())?;
        let mut devices = vec![CaptureDevice {
            id: "desktop".into(),
            name: "整个桌面".into(),
            kind: "screen".into(),
        }];
        devices.extend(parse_devices(&String::from_utf8_lossy(&out.stderr), false));
        Ok(devices)
    } else {
        Ok(vec![])
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
                    });
                }
            }
        }
    }
    result
}
