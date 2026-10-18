use super::{analysis, run_process, TaskControl, MEDIA_FORMATS};
use crate::engine::{process, MediaStore, Result, Runtime};
use serde_json::{json, Value};

fn field(line: &str, key: &str) -> Option<f64> {
    let value = line
        .split_once(key)?
        .1
        .trim_start()
        .split(|c: char| c.is_whitespace() || c == '|')
        .next()?
        .parse::<f64>()
        .ok()?;
    value.is_finite().then_some(value)
}

/// Decode a bounded section of an exported preview. Dark frames and silence
/// are measured observations, not proof that a cut or render is defective.
pub fn validate_export(
    store: &MediaStore,
    runtime: &Runtime,
    asset: &Value,
    start: f64,
    end: Option<f64>,
    threshold: f64,
    minimum: f64,
    control: &TaskControl,
) -> Result<Value> {
    if !start.is_finite()
        || start < 0.
        || !threshold.is_finite()
        || !(0.01..=0.5).contains(&threshold)
        || !minimum.is_finite()
        || !(0.01..=10.).contains(&minimum)
    {
        return Err("导出检查的时间范围或黑场阈值无效。".into());
    }
    let path = store.authorized_path(asset)?;
    let info = analysis::probe(store, runtime, asset, control)?;
    let duration = info["duration"].as_f64().ok_or("导出预览没有有效时长。")?;
    let end = end.unwrap_or((start + 60.).min(duration));
    if !end.is_finite() || end <= start || end > duration + 0.01 || end - start > 60.01 {
        return Err("导出检查每次最多分析 60 秒，且必须位于媒体时长内。".into());
    }
    let streams = info["streams"].as_array().ok_or("预览媒体流信息无效。")?;
    let video = streams
        .iter()
        .find(|stream| stream["type"] == "video" && stream["attachedPicture"] != true);
    let audio = streams.iter().find(|stream| stream["type"] == "audio");
    let mut command = process(&runtime.encoder);
    command
        .args([
            "-hide_banner",
            "-nostdin",
            "-v",
            "info",
            "-xerror",
            "-err_detect",
            "explode",
            "-protocol_whitelist",
            "file,pipe",
            "-format_whitelist",
            MEDIA_FORMATS,
            "-ss",
        ])
        .arg(start.to_string())
        .arg("-i")
        .arg(path)
        .arg("-t")
        .arg((end - start).to_string());
    if let Some(video) = video {
        let index = video["index"].as_u64().ok_or("视频流编号无效。")?;
        command.args([
            "-map",
            &format!("0:{index}"),
            "-vf",
            &format!("blackdetect=d={minimum}:pix_th={threshold}:pic_th=0.98"),
        ]);
    } else {
        command.arg("-vn");
    }
    if let Some(audio) = audio {
        let index = audio["index"].as_u64().ok_or("音频流编号无效。")?;
        command.args([
            "-map",
            &format!("0:{index}"),
            "-af",
            "astats=metadata=1:reset=0,silencedetect=noise=-50dB:d=0.25",
        ]);
    } else {
        command.arg("-an");
    }
    command.args(["-sn", "-dn", "-threads", "1", "-f", "null", "-"]);
    let output = match run_process(command, control, 1024) {
        Ok(output) => output,
        Err(error) => {
            control.check()?;
            return Ok(
                json!({"decoded":false,"analyzedRange":{"start":start,"end":end},"blackIntervals":[],"audio":null,"warnings":["预览媒体解码失败。"],"errors":[error]}),
            );
        }
    };
    let mut black = Vec::new();
    let mut silence = Vec::new();
    let mut silent_since = None;
    let mut peak: Option<f64> = None;
    let mut peak_count: Option<f64> = None;
    for line in output.stderr.lines() {
        if let (Some(a), Some(b)) = (field(line, "black_start:"), field(line, "black_end:")) {
            if b > a {
                black.push(json!({"start":start+a.max(0.),"end":(start+b).min(end),"duration":b-a,"evidence":{"detector":"blackdetect","pixelThreshold":threshold,"pictureBlackRatio":0.98}}));
            }
        }
        if let Some(value) = field(line, "silence_start:") {
            silent_since = Some(value.max(0.));
        }
        if let Some(value) = field(line, "silence_end:") {
            if let Some(a) = silent_since.take() {
                silence.push(json!({"start":start+a,"end":(start+value).min(end),"duration":(value-a).max(0.)}));
            }
        }
        if let Some(value) = field(line, "Peak level dB:") {
            peak = Some(peak.map_or(value, |previous| previous.max(value)));
        }
        if let Some(value) = field(line, "Peak count:") {
            peak_count = Some(peak_count.map_or(value, |previous| previous.max(value)));
        }
    }
    if let Some(a) = silent_since {
        silence.push(json!({"start":start+a,"end":end,"duration":(end-start-a).max(0.)}));
    }
    let possible_clipping = peak.is_some_and(|value| value >= -0.1);
    let mut warnings = Vec::new();
    if !black.is_empty() {
        warnings.push("检测到黑场区间；片头、片尾或设计转场也可能产生黑场。".to_string());
    }
    if possible_clipping {
        warnings.push("音频峰值接近或达到数字满刻度，可能存在削波，请试听确认。".to_string());
    }
    if !silence.is_empty() {
        warnings.push("检测到静音区间；这不代表导出错误。".to_string());
    }
    Ok(
        json!({"decoded":true,"analyzedRange":{"start":start,"end":end},"sourceDuration":duration,"blackIntervals":black,"audio":audio.map(|stream|json!({"streamIndex":stream["index"],"peakDbfs":peak,"possibleClipping":possible_clipping,"peakOccurrences":peak_count,"silenceIntervals":silence,"evidence":{"detector":"astats/silencedetect","clippingWarningThresholdDbfs":-0.1,"silenceThresholdDbfs":-50,"minimumSilenceDuration":0.25},"note":"峰值接近满刻度属于风险提示，不是已确认削波样本计数。"})),"warnings":warnings,"errors":[]}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn real_preview_decode_reports_black_and_silence_without_classifying_them_as_bad_frames() {
        let directory = tempfile::tempdir().unwrap();
        let store = MediaStore::new(directory.path()).unwrap();
        let runtime = Runtime::discover(None, None).unwrap();
        let file = store.root.join("preview.mkv");
        let control = TaskControl::new(Duration::from_secs(20));
        let mut command = process(&runtime.encoder);
        command
            .args([
                "-hide_banner",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=black:s=96x64:r=10:d=1",
                "-f",
                "lavfi",
                "-i",
                "color=red:s=96x64:r=10:d=1",
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
            .arg(&file);
        run_process(command, &control, 1024).unwrap();
        let asset = json!({"id":"preview","nativePath":file});
        let result =
            validate_export(&store, &runtime, &asset, 0., None, 0.1, 0.1, &control).unwrap();
        assert_eq!(result["decoded"], true);
        assert!(result["errors"].as_array().unwrap().is_empty());
        assert!((result["blackIntervals"][0]["duration"].as_f64().unwrap() - 1.).abs() < 0.11);
        assert!(
            result["audio"]["silenceIntervals"][0]["duration"]
                .as_f64()
                .unwrap()
                > 1.9
        );
        assert_eq!(result["audio"]["possibleClipping"], false);
        assert!(!result["warnings"].as_array().unwrap().is_empty());
        assert!(
            validate_export(&store, &runtime, &asset, 0., Some(90.), 0.1, 0.1, &control).is_err()
        );
    }

    #[test]
    fn real_full_scale_tone_reports_peak_risk_and_cancellation() {
        let directory = tempfile::tempdir().unwrap();
        let store = MediaStore::new(directory.path()).unwrap();
        let runtime = Runtime::discover(None, None).unwrap();
        let file = store.root.join("peak.wav");
        let control = TaskControl::new(Duration::from_secs(20));
        let mut command = process(&runtime.encoder);
        command
            .args([
                "-hide_banner",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "aevalsrc=1:s=16000:d=0.5",
                "-c:a",
                "pcm_f32le",
                "-y",
            ])
            .arg(&file);
        run_process(command, &control, 1024).unwrap();
        let asset = json!({"id":"peak","nativePath":file});
        let result =
            validate_export(&store, &runtime, &asset, 0., None, 0.1, 0.1, &control).unwrap();
        assert_eq!(result["decoded"], true);
        assert_eq!(result["audio"]["peakDbfs"], 0.);
        assert_eq!(result["audio"]["possibleClipping"], true);
        control
            .cancelled
            .store(true, std::sync::atomic::Ordering::Release);
        assert!(validate_export(&store, &runtime, &asset, 0., None, 0.1, 0.1, &control).is_err());
    }
}
