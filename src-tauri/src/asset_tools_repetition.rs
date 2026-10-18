use crate::{
    asset_tools::{analysis, run_process, TaskControl, MEDIA_FORMATS},
    engine::{process, MediaStore, Result, Runtime},
};
use serde_json::{json, Value};

const FPS: usize = 2;
const WIDTH: usize = 16;
const HEIGHT: usize = 16;
const FRAME_BYTES: usize = WIDTH * HEIGHT * 3;
const MAX_SECONDS: usize = 180;
const MAX_FRAMES: usize = MAX_SECONDS * FPS;
const MIN_FRAMES: usize = 3 * FPS;
const GAP_FRAMES: usize = 2 * FPS;
const MATCH_THRESHOLD: f64 = 0.04;
const MOTION_THRESHOLD: f64 = 0.08;
const MIN_CHANGES: usize = 2;

fn mean_difference(left: &[u8], right: &[u8], threshold: f64) -> f64 {
    let maximum = (threshold * FRAME_BYTES as f64 * 255.0) as u64;
    let mut total = 0_u64;
    for (left, right) in left.iter().zip(right) {
        total += u8::abs_diff(*left, *right) as u64;
        if total > maximum {
            return 1.0;
        }
    }
    total as f64 / (FRAME_BYTES as f64 * 255.0)
}

fn repeat_intervals(bytes: &[u8], duration: f64, control: &TaskControl) -> Result<Vec<Value>> {
    if bytes.len() % FRAME_BYTES != 0 || bytes.len() > MAX_FRAMES * FRAME_BYTES {
        return Err("重复画面采样数据无效。".into());
    }
    let frames = bytes.chunks_exact(FRAME_BYTES).collect::<Vec<_>>();
    if frames.len() < MIN_FRAMES * 2 + GAP_FRAMES {
        return Ok(Vec::new());
    }
    let mut changes = vec![0_usize; frames.len() + 1];
    for index in 1..frames.len() {
        changes[index + 1] = changes[index]
            + usize::from(
                mean_difference(frames[index - 1], frames[index], MOTION_THRESHOLD)
                    > MOTION_THRESHOLD,
            );
    }
    let change_count = |start: usize, count: usize| changes[start + count] - changes[start + 1];
    let mut distances = vec![f64::NAN; frames.len() * frames.len()];
    let mut intervals = Vec::new();
    let mut current = MIN_FRAMES + GAP_FRAMES;
    while current + MIN_FRAMES <= frames.len() {
        control.check()?;
        if change_count(current, MIN_FRAMES) < MIN_CHANGES {
            current += 1;
            continue;
        }
        let mut best: Option<(usize, usize, f64)> = None;
        for reference in 0..=current - MIN_FRAMES - GAP_FRAMES {
            if reference % 16 == 0 {
                control.check()?;
            }
            if change_count(reference, MIN_FRAMES) < MIN_CHANGES {
                continue;
            }
            let maximum = (current - reference - GAP_FRAMES).min(frames.len() - current);
            let mut matched = 0;
            let mut total = 0.0;
            while matched < maximum {
                let slot = (reference + matched) * frames.len() + current + matched;
                if distances[slot].is_nan() {
                    distances[slot] = mean_difference(
                        frames[reference + matched],
                        frames[current + matched],
                        MATCH_THRESHOLD,
                    );
                }
                if distances[slot] > MATCH_THRESHOLD {
                    break;
                }
                total += distances[slot];
                matched += 1;
            }
            if matched >= MIN_FRAMES
                && best.as_ref().is_none_or(|(_, count, difference)| {
                    matched > *count || matched == *count && total / (matched as f64) < *difference
                })
            {
                best = Some((reference, matched, total / matched as f64));
            }
        }
        if let Some((reference, count, difference)) = best {
            let start = current as f64 / FPS as f64;
            let end = ((current + count) as f64 / FPS as f64).min(duration);
            let reference_start = reference as f64 / FPS as f64;
            let reference_end = ((reference + count) as f64 / FPS as f64).min(duration);
            if end - start >= 3.0 {
                intervals.push(json!({
                    "start":start, "end":end, "duration":end-start,
                    "referenceStart":reference_start, "referenceEnd":reference_end,
                    "similarity":1.0-difference, "confidence":1.0-difference,
                    "confidenceBasis":"visual_similarity_only",
                    "evidence": { "detector":"non_adjacent_visual_sequence", "metric":"mean_absolute_rgb_error",
                        "meanDifference":difference, "maximumMeanDifference":MATCH_THRESHOLD,
                        "sampleCount":count, "referenceChanges":change_count(reference,count),
                        "repeatedChanges":change_count(current,count), "sampleRate":FPS,
                        "sampleWidth":WIDTH, "sampleHeight":HEIGHT, "timePrecisionSeconds":1.0/FPS as f64 },
                }));
            }
            current += count;
        } else {
            current += 1;
        }
    }
    Ok(intervals)
}

pub fn detect_repeated_intervals(
    store: &MediaStore,
    runtime: &Runtime,
    asset: &Value,
    control: &TaskControl,
) -> Result<Value> {
    control.check()?;
    let path = store.authorized_path(asset)?;
    let metadata = analysis::probe(store, runtime, asset, control)?;
    let duration = metadata["duration"]
        .as_f64()
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(0.0);
    let supported = metadata["hasVideo"] == true && metadata["kind"] == "video";
    let end = if supported {
        duration.min(MAX_SECONDS as f64)
    } else {
        0.0
    };
    let mut intervals = Vec::new();
    let mut sampled_frames = 0;
    if supported && end >= (MIN_FRAMES * 2 + GAP_FRAMES) as f64 / FPS as f64 {
        let video_index = metadata["streams"]
            .as_array()
            .and_then(|streams| {
                streams
                    .iter()
                    .find(|stream| stream["type"] == "video" && stream["attachedPicture"] != true)
            })
            .and_then(|stream| stream["index"].as_u64())
            .ok_or("重复画面检测缺少有效视频流。")?;
        let mut command = process(&runtime.encoder);
        command
            .args([
                "-hide_banner",
                "-nostdin",
                "-loglevel",
                "error",
                "-protocol_whitelist",
                "file,pipe",
                "-format_whitelist",
                MEDIA_FORMATS,
                "-i",
            ])
            .arg(path)
            .arg("-map")
            .arg(format!("0:{video_index}"))
            .args(["-an", "-sn", "-dn", "-t"])
            .arg(format!("{end:.8}"))
            .arg("-vf")
            .arg(format!(
                "fps={FPS}:start_time=0,scale={WIDTH}:{HEIGHT}:flags=area,format=rgb24"
            ))
            .arg("-frames:v")
            .arg(MAX_FRAMES.to_string())
            .args([
                "-threads", "1", "-c:v", "rawvideo", "-f", "rawvideo", "pipe:1",
            ]);
        let output = run_process(command, control, MAX_FRAMES * FRAME_BYTES)?;
        sampled_frames = output.stdout.len() / FRAME_BYTES;
        intervals = repeat_intervals(&output.stdout, end, control)?;
    }
    Ok(json!({
        "repeatedIntervals":intervals,
        "scope": { "start":0.0, "end":end, "maxSeconds":MAX_SECONDS,
            "sampleRate":FPS, "sampledFrames":sampled_frames, "truncated":duration>MAX_SECONDS as f64,
            "supported":supported, "timeBase":"assetSeconds" },
        "threshold": { "maximumMeanDifference":MATCH_THRESHOLD, "minimumDuration":MIN_FRAMES as f64/FPS as f64,
            "minimumGap":GAP_FRAMES as f64/FPS as f64, "minimumChanges":MIN_CHANGES, "motionDifference":MOTION_THRESHOLD },
        "limitation":"仅检测低分辨率下相似的非相邻动态画面序列，不能判断是否为重复操作或无用内容。全静止画面不计为重复操作；短于3秒、变化很小或间隔不足2秒的重复可能遗漏，采样时间精度为0.5秒。",
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn fixture(repeated: bool) -> (tempfile::TempDir, MediaStore, Runtime, Value) {
        let directory = tempfile::tempdir().unwrap();
        let store = MediaStore::new(directory.path()).unwrap();
        let runtime = Runtime::discover(None, None).unwrap();
        let path = store.root.join("sequence.mkv");
        let mut command = process(&runtime.encoder);
        command.args(["-hide_banner", "-loglevel", "error"]);
        if repeated {
            for color in ["black", "white", "red", "blue", "black", "white", "red"] {
                command.args(["-f", "lavfi", "-i"]).arg(format!(
                    "color=c={color}:s=96x64:r=10:d={}",
                    if color == "blue" { 2 } else { 1 }
                ));
            }
            command.args([
                "-filter_complex",
                "[0:v][1:v][2:v][3:v][4:v][5:v][6:v]concat=n=7:v=1:a=0[v]",
                "-map",
                "[v]",
            ]);
        } else {
            command.args(["-f", "lavfi", "-i", "color=c=red:s=96x64:r=10:d=8"]);
        }
        let output = command
            .args(["-c:v", "ffv1", "-threads", "1", "-y"])
            .arg(&path)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let asset = json!({"id":"repeat-fixture","name":"sequence.mkv","nativePath":path});
        (directory, store, runtime, asset)
    }

    #[test]
    fn detects_actual_non_contiguous_repeated_video_sequence() {
        let (_directory, store, runtime, asset) = fixture(true);
        let value = detect_repeated_intervals(
            &store,
            &runtime,
            &asset,
            &TaskControl::new(Duration::from_secs(30)),
        )
        .unwrap();
        let intervals = value["repeatedIntervals"].as_array().unwrap();
        assert_eq!(intervals.len(), 1, "{value}");
        assert!(
            (intervals[0]["start"].as_f64().unwrap() - 5.0).abs() <= 0.5,
            "{value}"
        );
        assert_eq!(intervals[0]["referenceStart"], 0.0);
        assert!(intervals[0]["similarity"].as_f64().unwrap() > 0.99);
        assert_eq!(intervals[0]["evidence"]["sampleCount"], 6);
        assert_eq!(value["scope"]["truncated"], false);
    }

    #[test]
    fn entirely_static_video_is_not_classified_as_repeated_operation() {
        let (_directory, store, runtime, asset) = fixture(false);
        let value = detect_repeated_intervals(
            &store,
            &runtime,
            &asset,
            &TaskControl::new(Duration::from_secs(30)),
        )
        .unwrap();
        assert!(value["repeatedIntervals"].as_array().unwrap().is_empty());
        assert_eq!(value["scope"]["sampledFrames"], 16);
    }

    #[test]
    fn bounds_sampling_and_obeys_cancellation() {
        assert!(
            repeat_intervals(&[0_u8; 17], 8.0, &TaskControl::new(Duration::from_secs(5))).is_err()
        );
        let control = TaskControl::new(Duration::ZERO);
        let (_directory, store, runtime, asset) = fixture(true);
        assert!(detect_repeated_intervals(&store, &runtime, &asset, &control).is_err());
        let outside = tempfile::NamedTempFile::new().unwrap();
        assert!(detect_repeated_intervals(
            &store,
            &runtime,
            &json!({"nativePath":outside.path()}),
            &TaskControl::new(Duration::from_secs(5))
        )
        .unwrap_err()
        .contains("素材库"));
    }
}
