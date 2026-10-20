use crate::asset_tools::{run_process, TaskControl};
use crate::engine::{process, MediaStore, Result, Runtime};
use serde::Serialize;
use serde_json::Value;
use std::{fs, path::Path, process::Stdio};

#[derive(Serialize)]
pub struct PreviewResult {
    pub path: String,
}

/** Original media remains unchanged; these files only supply a compatible editor preview. */
pub fn create_preview(
    store: &MediaStore,
    runtime: &Runtime,
    asset: &Value,
    format: Option<&str>,
) -> Result<PreviewResult> {
    create_preview_inner(store, runtime, asset, format, None)
}

/// Compression previews share their task cancellation and cleanup directory.
pub(crate) fn create_compression_preview(
    store: &MediaStore,
    runtime: &Runtime,
    asset: &Value,
    format: Option<&str>,
    directory: &Path,
    control: &TaskControl,
) -> Result<PreviewResult> {
    control.check()?;
    create_preview_inner(store, runtime, asset, format, Some((directory, control)))
}
fn create_preview_inner(
    store: &MediaStore,
    runtime: &Runtime,
    asset: &Value,
    format: Option<&str>,
    task: Option<(&Path, &TaskControl)>,
) -> Result<PreviewResult> {
    let original = store.authorized_path(asset)?;
    let kind = asset["kind"].as_str().ok_or("素材类型无效。")?;
    let extension = match (kind, format) {
        ("image", None | Some("png")) => "png",
        ("video", None | Some("mp4")) => "mp4",
        ("video", Some("webm")) => "webm",
        ("audio", None | Some("wav")) => "wav",
        _ => return Err("不支持这个素材类型的预览格式。".into()),
    };
    let directory = task
        .map(|(directory, _)| directory.join("preview"))
        .unwrap_or_else(|| store.root.join("preview"));
    fs::create_dir_all(&directory).map_err(|e| format!("无法创建预览目录：{e}"))?;
    let name = original
        .file_name()
        .ok_or("素材文件名称无效。")?
        .to_string_lossy();
    let output = directory.join(format!("{name}.v1.{extension}"));
    if complete_file(&output) {
        return Ok(PreviewResult {
            path: output.to_string_lossy().into_owned(),
        });
    }
    let temporary = tempfile::NamedTempFile::new_in(&directory)
        .map_err(|e| format!("无法创建预览文件：{e}"))?;
    let mut command = process(&runtime.encoder);
    command
        .args([
            "-hide_banner",
            "-nostdin",
            "-y",
            "-loglevel",
            "error",
            "-threads",
            "2",
        ])
        .arg("-i")
        .arg(&original);
    match kind {
        "image" => {
            command.args([
                "-map",
                "0:V:0",
                "-frames:v",
                "1",
                "-an",
                "-sn",
                "-dn",
                "-c:v",
                "png",
                "-pix_fmt",
                "rgba",
                "-update",
                "1",
                "-f",
                "image2",
            ]);
        }
        "video" => {
            command.args([
                "-map", "0:V:0", "-map", "0:a:0?", "-sn", "-dn",
                "-vf", "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1",
                "-pix_fmt", "yuv420p", "-ac", "2", "-ar", "48000",
            ]);
            if extension == "webm" {
                command.args([
                    "-c:v",
                    "libvpx",
                    "-deadline",
                    "realtime",
                    "-cpu-used",
                    "5",
                    "-crf",
                    "16",
                    "-b:v",
                    "2500k",
                    "-c:a",
                    "libopus",
                    "-b:a",
                    "128k",
                    "-f",
                    "webm",
                ]);
            } else {
                command.args([
                    "-c:v",
                    "libx264",
                    "-preset",
                    "veryfast",
                    "-crf",
                    "22",
                    "-c:a",
                    "aac",
                    "-b:a",
                    "160k",
                    "-movflags",
                    "+faststart",
                    "-f",
                    "mp4",
                ]);
            }
        }
        "audio" => {
            command.args([
                "-map",
                "0:a:0",
                "-vn",
                "-sn",
                "-dn",
                "-c:a",
                "pcm_s16le",
                "-ac",
                "2",
                "-ar",
                "48000",
                "-f",
                "wav",
            ]);
        }
        _ => unreachable!(),
    }
    command.arg(temporary.path());
    if let Some((_, control)) = task {
        run_process(command, control, 64 * 1024)
            .map_err(|error| format!("无法生成兼容预览；原始素材未修改。{error}"))?;
        control.check()?;
    } else {
        let result = command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .map_err(|e| format!("无法启动兼容预览生成：{e}"))?;
        if !result.status.success() {
            let detail = String::from_utf8_lossy(&result.stderr);
            return Err(format!(
                "无法生成兼容预览；原始素材未修改。{}",
                detail.chars().take(1000).collect::<String>()
            ));
        }
    }
    if !complete_file(temporary.path()) {
        return Err("无法生成完整的兼容预览；原始素材未修改。".into());
    }
    temporary
        .as_file()
        .sync_all()
        .map_err(|e| format!("无法保存兼容预览：{e}"))?;
    match temporary.persist(&output) {
        Ok(_) => (),
        Err(error) if complete_file(&output) => {
            drop(error);
        }
        Err(error) => return Err(format!("无法保存兼容预览：{}", error.error)),
    }
    Ok(PreviewResult {
        path: output.to_string_lossy().into_owned(),
    })
}

fn complete_file(path: &Path) -> bool {
    fs::metadata(path)
        .map(|meta| meta.is_file() && meta.len() > 0)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture(runtime: &Runtime, path: &Path, args: &[&str]) {
        let output = process(&runtime.encoder)
            .args(["-hide_banner", "-nostdin", "-y", "-loglevel", "error"])
            .args(args)
            .arg(path)
            .output()
            .expect("fixture encoder starts");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn metadata(runtime: &Runtime, path: &Path) -> Value {
        let output = process(&runtime.probe)
            .args([
                "-v",
                "error",
                "-show_streams",
                "-show_format",
                "-of",
                "json",
            ])
            .arg(path)
            .output()
            .unwrap();
        assert!(output.status.success());
        serde_json::from_slice(&output.stdout).unwrap()
    }

    #[test]
    fn compatible_previews_encode_real_images_video_audio_and_preserve_originals() {
        let runtime = Runtime::discover(None, None)
            .expect("media runtime is required for the preview integration test");
        let workspace = tempfile::tempdir().unwrap();
        let store = MediaStore::new(workspace.path()).unwrap();
        let examples = [
            (
                "picture.tiff",
                vec![
                    "-f",
                    "lavfi",
                    "-i",
                    "color=c=red:s=160x90",
                    "-frames:v",
                    "1",
                ],
                "png",
            ),
            (
                "movie.avi",
                vec![
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc2=s=160x90:r=15",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=440:sample_rate=48000",
                    "-t",
                    "0.6",
                    "-c:v",
                    "mpeg4",
                    "-c:a",
                    "pcm_s16le",
                ],
                "h264",
            ),
            (
                "audio.flac",
                vec![
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=880:sample_rate=48000",
                    "-t",
                    "0.6",
                    "-c:a",
                    "flac",
                ],
                "pcm_s16le",
            ),
        ];
        for (name, args, codec) in examples {
            let path = workspace.path().join(name);
            fixture(&runtime, &path, &args);
            let asset = store.import(&runtime, &path, None).unwrap();
            let original_bytes = fs::read(&asset.native_path).unwrap();
            let value = serde_json::to_value(&asset).unwrap();
            let preview = create_preview(&store, &runtime, &value, None).unwrap();
            assert_ne!(preview.path, asset.native_path);
            assert_eq!(fs::read(&asset.native_path).unwrap(), original_bytes);
            assert!(PathBuf::from(&preview.path).starts_with(&store.root));
            let info = metadata(&runtime, Path::new(&preview.path));
            assert_eq!(info["streams"][0]["codec_name"], codec);
            if asset.kind != "audio" {
                assert_eq!(info["streams"][0]["width"], 160);
                assert_eq!(info["streams"][0]["height"], 90);
            }
            if asset.kind == "video" {
                assert!(info["streams"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|stream| stream["codec_name"] == "aac"));
                let duration = info["format"]["duration"]
                    .as_str()
                    .unwrap()
                    .parse::<f64>()
                    .unwrap();
                assert!((duration - asset.duration).abs() < 0.15);
                let webm = create_preview(&store, &runtime, &value, Some("webm")).unwrap();
                assert_ne!(webm.path, preview.path);
                let fallback = metadata(&runtime, Path::new(&webm.path));
                assert_eq!(fallback["streams"][0]["codec_name"], "vp8");
                assert!(fallback["streams"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|stream| stream["codec_name"] == "opus"));
                assert_eq!(fs::read(&asset.native_path).unwrap(), original_bytes);
            }
            let modified = fs::metadata(&preview.path).unwrap().modified().unwrap();
            assert_eq!(
                create_preview(&store, &runtime, &value, None).unwrap().path,
                preview.path
            );
            assert_eq!(
                fs::metadata(&preview.path).unwrap().modified().unwrap(),
                modified
            );
            assert!(create_preview(&store, &runtime, &value, Some("invalid")).is_err());
        }
    }
}
