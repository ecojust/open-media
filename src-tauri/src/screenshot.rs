use crate::{
    capture_picker::PickerSelection,
    engine::{Asset, MediaStore, Result, Runtime},
};
use std::{
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
#[cfg(any(target_os = "macos", test))]
use std::fs;
#[cfg(target_os = "macos")]
use std::{process::{Child, Command, Stdio}, thread, time::{Duration, Instant}};

static CAPTURING: AtomicBool = AtomicBool::new(false);

struct CaptureSession;
impl Drop for CaptureSession {
    fn drop(&mut self) {
        CAPTURING.store(false, Ordering::SeqCst);
    }
}

#[cfg(target_os = "macos")]
struct CaptureChild(Child);
#[cfg(target_os = "macos")]
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
    store
        .workspace_store("screenshot")?
        .import_png(&output, &format!("截屏-{stamp}.png"))
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
    _runtime: &Runtime,
    selection: &PickerSelection,
    _directory: &Path,
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
    capture_windows::capture_png(&target, &bounds, output)
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

#[cfg(target_os = "macos")]
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_png_import_preserves_pixels_and_needs_no_media_process() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("capture.png");
        let file = fs::File::create(&source).unwrap();
        let mut encoder = png::Encoder::new(file, 2, 2);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let pixels = [255, 0, 0, 0, 255, 0, 0, 0, 255, 42, 128, 233];
        encoder.write_header().unwrap().write_image_data(&pixels).unwrap();
        let store = MediaStore::new(directory.path()).unwrap();
        let asset = store.import_png(&source, "截屏.png").unwrap();
        assert_eq!((asset.width, asset.height, asset.duration), (2, 2, 5.0));
        assert_eq!(asset.kind, "image");
        assert_eq!(asset.mime, "image/png");
        assert_eq!(asset.name, "截屏.png");
        assert_eq!(fs::read(&source).unwrap(), fs::read(&asset.native_path).unwrap());
        let file = fs::File::open(&asset.native_path).unwrap();
        let mut reader = png::Decoder::new(std::io::BufReader::new(file)).read_info().unwrap();
        let mut actual = vec![0; reader.output_buffer_size().unwrap()];
        reader.next_frame(&mut actual).unwrap();
        assert_eq!(actual, pixels);
    }

    #[test]
    fn known_png_import_rejects_bad_header_and_truncated_pixel_data() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("capture.png");
        let mut valid = Vec::new();
        let mut encoder = png::Encoder::new(&mut valid, 16, 16);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.write_header().unwrap().write_image_data(&vec![143; 16 * 16 * 3]).unwrap();
        let store = MediaStore::new(directory.path()).unwrap();
        for length in [0, 8, 29, 48, valid.len() - 20] {
            fs::write(&source, &valid[..length]).unwrap();
            assert!(store.import_png(&source, "截屏.png").is_err(), "truncated at {length}");
            assert_eq!(fs::read_dir(&store.root).unwrap().count(), 0, "failed PNG must not enter the media library");
        }
        valid[0] = 0;
        fs::write(&source, valid).unwrap();
        assert!(store.import_png(&source, "截屏.png").is_err());
    }
}
