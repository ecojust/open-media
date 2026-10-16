use crate::{
    capture_picker::PickerSelection,
    engine::{Asset, MediaStore, Result, Runtime},
};
use std::{
    fs,
    path::Path,
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

static CAPTURING: AtomicBool = AtomicBool::new(false);

struct CaptureSession;
impl Drop for CaptureSession {
    fn drop(&mut self) {
        CAPTURING.store(false, Ordering::SeqCst);
    }
}

struct CaptureChild(Child);
impl Drop for CaptureChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// A selected source is captured once at its original pixel size. Video output
/// presets have no effect on screenshots, and no microphone or border is started.
pub fn capture(runtime: &Runtime, store: &MediaStore, selection: &PickerSelection) -> Result<Asset> {
    validate_selection(selection)?;
    CAPTURING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .map_err(|_| "已有截屏正在进行，请稍候。")?;
    let _session = CaptureSession;
    let directory = tempfile::tempdir().map_err(|e| format!("无法创建截屏目录：{e}"))?;
    let output = directory.path().join("screenshot.png");
    capture_file(runtime, selection, directory.path(), &output)?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    store.import(runtime, &output, Some(&format!("截屏-{stamp}.png")))
}

fn validate_selection(selection: &PickerSelection) -> Result<()> {
    if selection.source_id.len() > 128
        || !(selection.source_id.starts_with("screen:")
            || selection.source_id.starts_with("window:"))
    {
        return Err("请选择有效的截屏来源。".into());
    }
    if let Some(region) = &selection.region {
        if !selection.source_id.starts_with("screen:")
            || region.x < 0
            || region.y < 0
            || region.width < 16
            || region.height < 16
            || u64::from(region.width) * u64::from(region.height) > 100_000_000
        {
            return Err("截屏区域无效，请重新选择。".into());
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn capture_file(
    _runtime: &Runtime,
    selection: &PickerSelection,
    directory: &Path,
    output: &Path,
) -> Result<()> {
    let config = directory.join("screenshot.json");
    fs::write(
        &config,
        serde_json::to_vec(selection).map_err(|e| format!("截屏配置无效：{e}"))?,
    )
    .map_err(|e| format!("无法写入截屏配置：{e}"))?;
    let mut command = crate::capture_service::command()?;
    command.arg("screenshot").arg(config).arg(output);
    run_capture(command, directory)
}

#[cfg(target_os = "windows")]
fn capture_file(
    runtime: &Runtime,
    selection: &PickerSelection,
    directory: &Path,
    output: &Path,
) -> Result<()> {
    use crate::capture_windows;
    let target = capture_windows::resolve_target(&selection.source_id)?;
    if selection
        .source_width
        .is_some_and(|width| width != target.bounds.width)
        || selection
            .source_height
            .is_some_and(|height| height != target.bounds.height)
    {
        return Err("截屏来源的尺寸已改变，请重新选择。".into());
    }
    let region = selection.region.as_ref().map(|region| capture_windows::CaptureBounds {
        x: region.x,
        y: region.y,
        width: region.width,
        height: region.height,
    });
    let bounds = capture_windows::capture_bounds(&target, region.as_ref())?;
    if u64::from(bounds.width) * u64::from(bounds.height) > 100_000_000 {
        return Err("截屏范围过大，请选择较小的区域。".into());
    }
    let mut command = crate::engine::process(&runtime.encoder);
    command.args([
        "-hide_banner", "-y", "-loglevel", "error", "-f", "gdigrab", "-framerate", "1",
        "-draw_mouse", "0",
    ]);
    if target.kind == "window" {
        let handle = capture_windows::window_handle(&selection.source_id)?;
        command.args(["-i", &format!("hwnd={handle}")]);
    } else {
        command.args([
            "-offset_x", &bounds.x.to_string(),
            "-offset_y", &bounds.y.to_string(),
            "-video_size", &format!("{}x{}", bounds.width, bounds.height),
            "-i", "desktop",
        ]);
    }
    command.args(["-frames:v", "1", "-an", "-c:v", "png", "-update", "1"]).arg(output);
    run_capture(command, directory)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn capture_file(
    _runtime: &Runtime,
    _selection: &PickerSelection,
    _directory: &Path,
    _output: &Path,
) -> Result<()> {
    Err("桌面截屏支持 macOS 和 Windows。".into())
}

fn run_capture(mut command: Command, directory: &Path) -> Result<()> {
    let errors = directory.join("screenshot.log");
    let mut child = CaptureChild(
        command
            // Keep the pipe alive until completion. On macOS, EOF releases the
            // screen stream if the application exits while a frame is pending.
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::from(fs::File::create(&errors).map_err(|e| e.to_string())?))
            .spawn()
            .map_err(|e| format!("无法开始截屏：{e}"))?,
    );
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        match child.0.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(_)) => {
                let detail = fs::read_to_string(&errors).unwrap_or_default();
                let detail: String = detail.chars().rev().take(1500).collect::<Vec<_>>()
                    .into_iter().rev().collect();
                return Err(format!("截屏失败。{}", detail.trim()));
            }
            Err(error) => return Err(format!("无法读取截屏结果：{error}")),
            Ok(None) if Instant::now() >= deadline => {
                return Err("截屏超时，请检查屏幕录制权限后重新选择范围。".into());
            }
            Ok(None) => thread::sleep(Duration::from_millis(40)),
        }
    }
}
