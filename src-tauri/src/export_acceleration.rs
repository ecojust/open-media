//! Probe real hardware encoding before selecting a video encoder.
use super::{process, Result, Runtime, VideoTarget};
use std::{
    fs::{self, File},
    io::Read,
    path::Path,
    process::{Child, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Encoder {
    Cpu,
    VideoToolbox,
    Nvenc,
    Qsv,
    Amf,
    Vp9Qsv,
}
impl Encoder {
    pub(super) fn label(self) -> &'static str {
        match self {
            Self::Cpu => "CPU",
            Self::VideoToolbox => "GPU（VideoToolbox）",
            Self::Nvenc => "GPU（NVENC）",
            Self::Qsv | Self::Vp9Qsv => "GPU（QSV）",
            Self::Amf => "GPU（AMF）",
        }
    }
    fn codec(self) -> &'static str {
        match self {
            Self::Cpu => "libx264",
            Self::VideoToolbox => "h264_videotoolbox",
            Self::Nvenc => "h264_nvenc",
            Self::Qsv => "h264_qsv",
            Self::Amf => "h264_amf",
            Self::Vp9Qsv => "vp9_qsv",
        }
    }
    fn device_options(self) -> &'static [&'static str] {
        match self {
            // An implicit legacy QSV session may select a software implementation.
            // Bind the encoder to an explicitly hardware-only device instead.
            Self::Qsv | Self::Vp9Qsv => &["-init_hw_device", "qsv=media_encode:hw_any"],
            _ => &[],
        }
    }
    fn options(self, target: &VideoTarget, bitrate: Option<&str>) -> Vec<String> {
        let quality = match target.quality.as_str() {
            "draft" => "30",
            "compact" => "28",
            "high" => "18",
            _ => "23",
        };
        let mut args = vec!["-c:v".into(), self.codec().into()];
        let extra: &[&str] = match self {
            Self::Cpu => &["-crf", quality, "-preset", "medium"],
            Self::VideoToolbox => &["-allow_sw", "0"],
            Self::Nvenc => &["-preset", "p4", "-rc", "vbr", "-cq", quality],
            Self::Qsv | Self::Vp9Qsv => &["-preset", "medium", "-global_quality", quality],
            Self::Amf => &[
                "-quality", "balanced", "-rc", "cqp", "-qp_i", quality, "-qp_p", quality, "-qp_b",
                quality,
            ],
        };
        args.extend(extra.iter().map(|s| s.to_string()));
        if let Some(bitrate) = bitrate {
            if self == Self::Amf {
                args = vec![
                    "-c:v".into(),
                    self.codec().into(),
                    "-quality".into(),
                    "balanced".into(),
                    "-rc".into(),
                    "vbr_peak".into(),
                ];
            }
            args.extend(["-b:v".into(), bitrate.into()]);
        } else if self == Self::VideoToolbox {
            let factor = match target.quality.as_str() {
                "draft" => 0.07,
                "compact" => 0.09,
                "high" => 0.24,
                _ => 0.14,
            };
            let bitrate = ((target.width as f64 * target.height as f64 * target.fps * factor)
                as u64)
                .clamp(350_000, 200_000_000);
            args.extend(["-b:v".into(), bitrate.to_string()]);
        } else if self == Self::Nvenc {
            args.extend(["-b:v".into(), "0".into()]);
        }
        args
    }
}

fn value<'a>(args: &'a [String], option: &str) -> Option<&'a str> {
    args.windows(2)
        .rev()
        .find(|pair| pair[0] == option)
        .map(|pair| pair[1].as_str())
}

pub(super) fn candidates(args: &[String], platform: &str) -> Vec<Encoder> {
    match (value(args, "-c:v"), platform) {
        (Some("libx264"), "macos") => vec![Encoder::VideoToolbox],
        (Some("libx264"), "windows" | "linux") => vec![Encoder::Nvenc, Encoder::Qsv, Encoder::Amf],
        (Some("libvpx-vp9"), "windows" | "linux") => vec![Encoder::Vp9Qsv],
        _ => Vec::new(),
    }
}

pub(super) fn arguments(
    original: &[String],
    target: &VideoTarget,
    encoder: Encoder,
) -> Vec<String> {
    if encoder == Encoder::Cpu {
        return original.to_owned();
    }
    let mut result = Vec::with_capacity(original.len() + 12);
    result.extend(
        encoder
            .device_options()
            .iter()
            .map(|value| value.to_string()),
    );
    let mut index = 0;
    // Encoding options alone change; input seeking, filters, maps, audio, color,
    // output dimensions, frame timing and container options remain byte-for-byte.
    while index < original.len() {
        if ["-c:v", "-crf", "-preset", "-b:v", "-deadline", "-cpu-used"]
            .contains(&original[index].as_str())
        {
            index += 2;
        } else {
            result.push(original[index].clone());
            index += 1;
        }
    }
    result.extend(encoder.options(
        target,
        value(original, "-b:v").filter(|value| *value != "0"),
    ));
    result
}

struct ProbeChild(Child);
impl Drop for ProbeChild {
    fn drop(&mut self) {
        if !matches!(self.0.try_wait(), Ok(Some(_))) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}
fn wait(child: &mut Child, cancelled: &AtomicBool, timeout: Duration) -> Result<bool> {
    let deadline = Instant::now() + timeout;
    loop {
        if cancelled.load(Ordering::SeqCst) {
            return Err("cancelled".into());
        }
        if Instant::now() >= deadline {
            return Ok(false);
        }
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => return Ok(status.success()),
            None => thread::sleep(Duration::from_millis(30)),
        }
    }
}

fn probe(
    runtime: &Runtime,
    target: &VideoTarget,
    encoder: Encoder,
    original: &[String],
    directory: &Path,
    cancelled: &AtomicBool,
) -> Result<bool> {
    let extension = if encoder == Encoder::Vp9Qsv {
        "webm"
    } else {
        "mp4"
    };
    let output = directory.join(format!("hardware-check.{extension}"));
    let log = directory.join("hardware-check.log");
    let stderr = File::create(&log).map_err(|e| e.to_string())?;
    let mut command = process(&runtime.encoder);
    command
        .args(encoder.device_options())
        .args([
            "-hide_banner",
            "-nostdin",
            "-y",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
        ])
        .arg(format!(
            "color=c=0x4682b4:s={}x{}:r={}",
            target.width, target.height, target.fps
        ))
        .args(["-frames:v", "3", "-an", "-pix_fmt", "yuv420p"])
        .args(encoder.options(
            target,
            value(original, "-b:v").filter(|value| *value != "0"),
        ))
        .arg(&output)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(stderr);
    let mut child = match command.spawn() {
        Ok(child) => ProbeChild(child),
        Err(_) => return Ok(false),
    };
    if !wait(&mut child.0, cancelled, Duration::from_secs(10))? {
        return Ok(false);
    }
    if fs::metadata(&output).map_or(true, |metadata| metadata.len() < 64) {
        return Ok(false);
    }
    let metadata = directory.join("hardware-check.json");
    let mut inspect = process(&runtime.probe);
    inspect
        .args([
            "-v",
            "error",
            "-count_frames",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=codec_name,width,height,nb_read_frames",
            "-of",
            "json",
        ])
        .arg(&output)
        .stdin(Stdio::null())
        .stdout(File::create(&metadata).map_err(|e| e.to_string())?)
        .stderr(Stdio::null());
    let mut child = match inspect.spawn() {
        Ok(child) => ProbeChild(child),
        Err(_) => return Ok(false),
    };
    if !wait(&mut child.0, cancelled, Duration::from_secs(5))? {
        return Ok(false);
    }
    let mut bytes = Vec::new();
    File::open(metadata)
        .map_err(|e| e.to_string())?
        .take(16 * 1024)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let Ok(info) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return Ok(false);
    };
    let stream = &info["streams"][0];
    Ok(stream["width"].as_u64() == Some(target.width as u64)
        && stream["height"].as_u64() == Some(target.height as u64)
        && stream["nb_read_frames"].as_str() == Some("3")
        && stream["codec_name"]
            == if encoder == Encoder::Vp9Qsv {
                "vp9"
            } else {
                "h264"
            })
}

pub(super) fn select(
    runtime: &Runtime,
    original: &[String],
    target: &VideoTarget,
    workspace: &Path,
    cancelled: &AtomicBool,
) -> Result<Encoder> {
    let directory = tempfile::Builder::new()
        .prefix("hardware-check-")
        .tempdir_in(workspace)
        .map_err(|e| e.to_string())?;
    for encoder in candidates(original, std::env::consts::OS) {
        if cancelled.load(Ordering::SeqCst) {
            return Err("cancelled".into());
        }
        if probe(
            runtime,
            target,
            encoder,
            original,
            directory.path(),
            cancelled,
        )? {
            return Ok(encoder);
        }
    }
    Ok(Encoder::Cpu)
}

pub(super) fn retryable_failure(encoder: Encoder, detail: &str, abnormal_exit: bool) -> bool {
    if encoder == Encoder::Cpu {
        return false;
    }
    let detail = detail.to_lowercase();
    if [
        "no space left",
        "permission denied",
        "read-only file system",
        "input/output error",
        "error writing",
        "error submitting a packet to the muxer",
        "av_interleaved_write_frame",
        "error closing file",
        "error opening input",
        "no such file",
        "invalid data found",
        "error while decoding",
        "error reinitializing filters",
        "error while filtering",
        "failed to inject frame",
    ]
    .iter()
    .any(|part| detail.contains(part))
    {
        return false;
    }
    abnormal_exit
        || [
            "nvenc",
            "videotoolbox",
            "qsv",
            "mfx",
            "amf",
            "cuda",
            "no capable devices",
            "device lost",
            "device failed",
            "device creation failed",
            "error while opening encoder",
            "error encoding a frame",
            "encode frame failed",
        ]
        .iter()
        .any(|part| detail.contains(part))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::{JobManager, RenderPlan};

    fn target() -> VideoTarget {
        VideoTarget {
            width: 128,
            height: 72,
            fps: 25.0,
            quality: "high".into(),
        }
    }
    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|s| s.to_string()).collect()
    }
    #[test]
    fn hardware_options_preserve_maps_filters_audio_timing_color_and_explicit_bitrate() {
        let base = strings(&[
            "-i",
            "original.mp4",
            "-ss",
            "1.23",
            "-t",
            "2.4",
            "-vf",
            "scale=128:72,eq=brightness=0.05",
            "-map",
            "0:v",
            "-map",
            "0:a",
            "-c:v",
            "libx264",
            "-crf",
            "18",
            "-preset",
            "medium",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-pix_fmt",
            "yuv420p",
            "-r",
            "25",
            "-colorspace",
            "bt709",
            "-movflags",
            "+faststart",
            "-b:v",
            "6000k",
        ]);
        let untouched = strings(&[
            "-i",
            "original.mp4",
            "-ss",
            "1.23",
            "-t",
            "2.4",
            "-vf",
            "scale=128:72,eq=brightness=0.05",
            "-map",
            "0:v",
            "-map",
            "0:a",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-pix_fmt",
            "yuv420p",
            "-r",
            "25",
            "-colorspace",
            "bt709",
            "-movflags",
            "+faststart",
        ]);
        for encoder in [
            Encoder::VideoToolbox,
            Encoder::Nvenc,
            Encoder::Qsv,
            Encoder::Amf,
        ] {
            let actual = arguments(&base, &target(), encoder);
            let prefix = encoder.device_options().len();
            assert_eq!(&actual[prefix..prefix + untouched.len()], untouched);
            assert_eq!(value(&actual, "-b:v"), Some("6000k"));
            assert_eq!(
                actual.iter().filter(|arg| arg.as_str() == "-c:v").count(),
                1
            );
            if encoder == Encoder::VideoToolbox {
                assert_eq!(value(&actual, "-allow_sw"), Some("0"));
            }
            if encoder == Encoder::Qsv {
                assert_eq!(
                    value(&actual, "-init_hw_device"),
                    Some("qsv=media_encode:hw_any")
                );
            }
        }
        assert_eq!(arguments(&base, &target(), Encoder::Cpu), base);
        assert!(candidates(&strings(&["-c:v", "png"]), "windows").is_empty());
        assert!(candidates(&strings(&["-an", "-loop", "0"]), "macos").is_empty());
        assert!(candidates(&strings(&["-c:v", "libvpx-vp9"]), "macos").is_empty());
        assert_eq!(
            candidates(&strings(&["-c:v", "libvpx-vp9"]), "windows"),
            vec![Encoder::Vp9Qsv]
        );
    }
    #[test]
    fn hardware_errors_can_retry_but_write_input_filter_and_cpu_errors_cannot() {
        for error in [
            "[h264_nvenc] No capable devices found",
            "[h264_qsv] Error while opening encoder",
            "[h264_amf] AMF device lost",
            "[h264_videotoolbox] Error encoding a frame",
            "[h264_nvenc] No capable devices found\nError opening output file staged.mp4",
            "Device creation failed\nError applying option 'init_hw_device' to global options",
        ] {
            assert!(retryable_failure(Encoder::Nvenc, error, false));
            assert!(!retryable_failure(Encoder::Cpu, error, true));
        }
        for error in [
            "h264_nvenc: No space left on device",
            "h264_qsv: Permission denied",
            "Error writing trailer: h264_amf",
            "h264_videotoolbox: Input/output error",
            "Error opening input original.mp4",
            "Error reinitializing filters!",
            "Failed to inject frame into filter network",
            "Error while decoding stream 0",
        ] {
            assert!(!retryable_failure(Encoder::Nvenc, error, true), "{error}");
        }
        assert!(!retryable_failure(
            Encoder::Nvenc,
            "Conversion failed",
            false
        ));
        assert!(retryable_failure(Encoder::Nvenc, "", true));
    }

    #[cfg(unix)]
    fn controlled_runtime(directory: &Path, failure: &str) -> Runtime {
        use std::os::unix::fs::PermissionsExt;
        let actual = Runtime::discover(None, None).unwrap();
        let settings = directory.join("encoder.json");
        fs::write(
            &settings,
            serde_json::to_vec(&serde_json::json!({"encoder":actual.encoder,"failure":failure}))
                .unwrap(),
        )
        .unwrap();
        let shim = directory.join("encoder-shim");
        fs::write(&shim,r#"#!/usr/bin/env python3
import json,pathlib,subprocess,sys,time
root=pathlib.Path(__file__).parent
config=json.loads((root/'encoder.json').read_text())
args=sys.argv[1:]
codec=args[args.index('-c:v')+1] if '-c:v' in args else ''
hardware=codec in ('h264_videotoolbox','h264_nvenc','h264_qsv','h264_amf','vp9_qsv')
probe='-frames:v' in args and args[args.index('-frames:v')+1]=='3'
with (root/'calls.txt').open('a') as calls: calls.write(('probe' if probe else 'export')+':'+codec+'\n')
if hardware and not probe:
    if config['failure']=='cancel': time.sleep(60)
    if config['failure']=='write': print('[h264_nvenc] Error writing trailer: No space left on device',file=sys.stderr)
    else: print('[h264_nvenc] No capable devices found',file=sys.stderr)
    sys.exit(1)
if hardware:
    skip={'-c:v','-preset','-rc','-cq','-quality','-qp_i','-qp_p','-qp_b','-global_quality','-allow_sw','-b:v'}
    filtered=[]; i=0
    while i<len(args):
        if args[i] in skip: i+=2
        else: filtered.append(args[i]); i+=1
    args=filtered[:-1]+['-c:v','libx264','-preset','ultrafast','-crf','18']+filtered[-1:]
sys.exit(subprocess.run([config['encoder'],*args],check=False).returncode)
"#).unwrap();
        fs::set_permissions(&shim, fs::Permissions::from_mode(0o755)).unwrap();
        Runtime {
            encoder: shim,
            ..actual
        }
    }
    #[cfg(unix)]
    #[test]
    fn actual_encoded_probe_precedes_export_and_gpu_failure_retries_once_without_touching_destination_early(
    ) {
        for failure in ["hardware", "write", "cancel"] {
            let root = tempfile::tempdir().unwrap();
            let runtime = controlled_runtime(root.path(), failure);
            let jobs = JobManager::default();
            let output = root.path().join("final.mp4");
            fs::write(&output, b"existing destination").unwrap();
            let plan = RenderPlan {
                args: strings(&[
                    "-f",
                    "lavfi",
                    "-i",
                    "color=c=red:s=128x72:r=25",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=440:sample_rate=48000",
                    "-t",
                    "0.4",
                    "-map",
                    "0:v",
                    "-map",
                    "1:a",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "medium",
                    "-crf",
                    "18",
                    "-c:a",
                    "aac",
                    "-pix_fmt",
                    "yuv420p",
                    "-r",
                    "25",
                ]),
                duration: 0.4,
                format: "mp4".into(),
                workspace: tempfile::tempdir().unwrap(),
                video: Some(target()),
            };
            let job = jobs.begin(&runtime, plan, output.clone()).unwrap();
            let deadline = Instant::now() + Duration::from_secs(20);
            let result = loop {
                if failure == "cancel"
                    && fs::read_to_string(root.path().join("calls.txt"))
                        .unwrap_or_default()
                        .contains("export:h264_")
                {
                    jobs.cancel(&job.id).unwrap();
                }
                let current = jobs
                    .list()
                    .into_iter()
                    .find(|item| item.id == job.id)
                    .unwrap();
                if current.state != "running" {
                    break current;
                }
                assert!(Instant::now() < deadline, "export test timeout");
                thread::sleep(Duration::from_millis(15));
            };
            let calls = fs::read_to_string(root.path().join("calls.txt")).unwrap();
            assert_eq!(
                calls
                    .lines()
                    .filter(|line| line.starts_with("probe:"))
                    .count(),
                1,
                "{calls}"
            );
            assert_eq!(
                calls
                    .lines()
                    .filter(|line| line.starts_with("export:h264_"))
                    .count(),
                1,
                "{calls}"
            );
            if failure == "hardware" {
                assert_eq!(result.state, "completed", "{:?}", result.error);
                assert_eq!(result.backend.as_deref(), Some("CPU"));
                assert!(result.fallback_reason.is_some());
                assert_eq!(
                    calls
                        .lines()
                        .filter(|line| *line == "export:libx264")
                        .count(),
                    1
                );
                let information = process(&runtime.probe)
                    .args([
                        "-v",
                        "error",
                        "-count_frames",
                        "-show_streams",
                        "-of",
                        "json",
                    ])
                    .arg(&output)
                    .output()
                    .unwrap();
                let info: serde_json::Value = serde_json::from_slice(&information.stdout).unwrap();
                let streams = info["streams"].as_array().unwrap();
                let video = streams
                    .iter()
                    .find(|stream| stream["codec_type"] == "video")
                    .unwrap();
                assert_eq!(video["width"], 128);
                assert_eq!(video["height"], 72);
                assert_eq!(video["nb_read_frames"], "10");
                assert_eq!(video["avg_frame_rate"], "25/1");
                assert!(streams
                    .iter()
                    .any(|stream| stream["codec_type"] == "audio"
                        && stream["sample_rate"] == "48000"));
                assert!(result.elapsed_seconds > 0.0);
                let elapsed = result.elapsed_seconds;
                thread::sleep(Duration::from_millis(20));
                assert_eq!(jobs.list()[0].elapsed_seconds, elapsed);
            } else {
                assert_eq!(
                    result.state,
                    if failure == "cancel" {
                        "cancelled"
                    } else {
                        "failed"
                    }
                );
                assert_eq!(fs::read(&output).unwrap(), b"existing destination");
                assert!(!calls.contains("export:libx264"));
            }
        }
    }
}
