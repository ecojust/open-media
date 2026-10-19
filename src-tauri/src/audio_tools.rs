use crate::engine::{self, MediaStore, Result, Runtime};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioToolJob {
    pub id: String,
    pub state: String,
    pub progress: f64,
    pub stage: String,
    pub result: Option<Value>,
    pub error: Option<String>,
}
struct Entry {
    job: AudioToolJob,
    cancelled: Arc<AtomicBool>,
    accepted: bool,
    output: Option<PathBuf>,
}
#[derive(Clone, Default)]
pub struct AudioToolsManager {
    jobs: Arc<Mutex<HashMap<String, Entry>>>,
}
impl AudioToolsManager {
    pub fn begin(
        &self,
        runtime: &Runtime,
        store: &MediaStore,
        spec: Value,
    ) -> Result<AudioToolJob> {
        let source = AudioSource::parse(store, &spec)?;
        let action = spec["action"]
            .as_str()
            .ok_or("音频操作缺少类型。")?
            .to_owned();
        if !["analyze", "normalize", "process", "ducking", "music_fit"].contains(&action.as_str()) {
            return Err("不支持的音频操作。".into());
        }
        let mut jobs = self.jobs.lock().map_err(|_| "音频任务状态不可用。")?;
        if jobs
            .values()
            .filter(|entry| entry.job.state == "running")
            .count()
            >= 2
        {
            return Err("正在处理音频，请等待当前任务完成。".into());
        }
        if jobs.len() >= 100 {
            jobs.retain(|_, entry| {
                entry.job.state == "running" || !entry.accepted && entry.output.is_some()
            });
        }
        if jobs.len() >= 100 {
            return Err("音频任务数量过多，请先接收或清理已完成任务。".into());
        }
        let id = engine::new_id();
        let job = AudioToolJob {
            id: id.clone(),
            state: "running".into(),
            progress: 0.0,
            stage: "正在准备音频".into(),
            result: None,
            error: None,
        };
        let cancelled = Arc::new(AtomicBool::new(false));
        jobs.insert(
            id.clone(),
            Entry {
                job: job.clone(),
                cancelled: cancelled.clone(),
                accepted: false,
                output: None,
            },
        );
        drop(jobs);
        let manager = self.clone();
        let runtime = runtime.clone();
        let store = store.clone();
        thread::spawn(move || {
            let result = manager.run(&id, &runtime, &store, &spec, &source, &cancelled);
            if let Ok(mut jobs) = manager.jobs.lock() {
                if let Some(entry) = jobs.get_mut(&id) {
                    match result {
                        Ok((value, output)) if !cancelled.load(Ordering::SeqCst) => {
                            entry.job.result = Some(value);
                            entry.output = output;
                            entry.job.state = "completed".into();
                            entry.job.stage = "音频处理完成".into();
                            entry.job.progress = 1.0;
                        }
                        Ok((_, output)) => {
                            if let Some(path) = output {
                                let _ = fs::remove_file(path);
                            }
                            entry.job.state = "cancelled".into();
                            entry.job.stage = "已取消".into();
                        }
                        Err(error) => {
                            entry.job.state = if cancelled.load(Ordering::SeqCst) {
                                "cancelled"
                            } else {
                                "failed"
                            }
                            .into();
                            entry.job.stage = if entry.job.state == "cancelled" {
                                "已取消"
                            } else {
                                "音频处理失败"
                            }
                            .into();
                            entry.job.error = Some(error);
                        }
                    }
                }
            }
        });
        Ok(job)
    }
    pub fn get(&self, id: &str) -> Result<AudioToolJob> {
        self.jobs
            .lock()
            .map_err(|_| "音频任务状态不可用。")?
            .get(id)
            .map(|entry| entry.job.clone())
            .ok_or_else(|| "音频任务不存在。".into())
    }
    pub fn list(&self) -> Vec<AudioToolJob> {
        self.jobs
            .lock()
            .map(|jobs| jobs.values().map(|entry| entry.job.clone()).collect())
            .unwrap_or_default()
    }
    pub fn cancel(&self, id: &str) -> Result<()> {
        let jobs = self.jobs.lock().map_err(|_| "音频任务状态不可用。")?;
        let entry = jobs.get(id).ok_or("音频任务不存在。")?;
        if entry.job.state == "running" {
            entry.cancelled.store(true, Ordering::SeqCst);
        }
        Ok(())
    }
    pub fn accept(&self, id: &str) -> Result<()> {
        let mut jobs = self.jobs.lock().map_err(|_| "音频任务状态不可用。")?;
        let entry = jobs.get_mut(id).ok_or("音频任务不存在。")?;
        if entry.job.state != "completed" {
            return Err("音频任务尚未完成。".into());
        }
        entry.accepted = true;
        Ok(())
    }
    pub fn discard(&self, id: &str) -> Result<()> {
        let mut jobs = self.jobs.lock().map_err(|_| "音频任务状态不可用。")?;
        let entry = jobs.get_mut(id).ok_or("音频任务不存在。")?;
        if entry.accepted {
            return Ok(());
        }
        entry.cancelled.store(true, Ordering::SeqCst);
        if let Some(path) = entry.output.take() {
            fs::remove_file(path).map_err(|error| format!("清理音频失败：{error}"))?;
        }
        if entry.job.state != "running" {
            entry.job.state = "cancelled".into();
            entry.job.stage = "结果已丢弃".into();
            entry.job.result = None;
        }
        Ok(())
    }
    pub fn cancel_all(&self) {
        if let Ok(jobs) = self.jobs.lock() {
            for entry in jobs.values() {
                if entry.job.state == "running" {
                    entry.cancelled.store(true, Ordering::SeqCst);
                }
            }
        }
    }
    pub fn shutdown(&self) {
        self.cancel_all();
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline && self.list().iter().any(|job| job.state == "running") {
            thread::sleep(Duration::from_millis(30));
        }
        // Completed results may already be referenced by a committed project even
        // if the final IPC acknowledgment failed. Only explicit discard deletes them.
    }
    fn progress(&self, id: &str, value: f64, stage: &str) {
        if let Ok(mut jobs) = self.jobs.lock() {
            if let Some(entry) = jobs.get_mut(id) {
                entry.job.progress = value.clamp(0.0, 0.99);
                entry.job.stage = stage.into();
            }
        }
    }
    fn run(
        &self,
        id: &str,
        runtime: &Runtime,
        store: &MediaStore,
        spec: &Value,
        source: &AudioSource,
        cancelled: &AtomicBool,
    ) -> Result<(Value, Option<PathBuf>)> {
        let workspace = tempfile::tempdir().map_err(|error| error.to_string())?;
        let action = spec["action"].as_str().unwrap_or("");
        let target_i = number(spec, "targetLufs", -16.0, -36.0, -5.0)?;
        let target_tp = number(spec, "truePeak", -1.0, -9.0, 0.0)?;
        let base = source.chain();
        let initial_analysis_filter = analysis_filter(&base, target_i, target_tp);
        let mut before = None;
        if action == "analyze" || action == "normalize" {
            let fraction = if action == "analyze" { 1.0 } else { 0.4 };
            let logs = self.encode(
                id,
                runtime,
                source,
                &initial_analysis_filter,
                source.duration,
                None,
                workspace.path(),
                cancelled,
                0.0,
                fraction,
                "正在测量响度与真峰值",
            )?;
            let measured = loudness(&logs, source.duration)?;
            if action == "analyze" {
                return Ok((measured.public(), None));
            }
            if measured.i.is_none() {
                return Err("音频为静音或无法测量响度，不能归一化。".into());
            }
            before = Some(measured);
        }
        let mut duration = source.duration;
        let filter = match action {
            "normalize" => {
                let m = before.as_ref().unwrap();
                format!("{base},loudnorm=I={target_i}:TP={target_tp}:LRA=11:measured_I={}:measured_TP={}:measured_LRA={}:measured_thresh={}:offset={}:linear=true:print_format=json", m.i.unwrap(), m.tp.ok_or("无法测量音频真峰值。")?, m.lra.unwrap_or(0.0), m.threshold.unwrap_or(-70.0), m.offset.unwrap_or(0.0))
            }
            "process" => format!("{base}{}", processing_chain(spec)?),
            "ducking" => format!(
                "{base},asetnsamples=n=240:p=0,volume='{}':eval=frame",
                ducking_expression(spec, duration)?
            ),
            "music_fit" => {
                duration = number(spec, "duration", source.duration, 0.01, 86400.0)?;
                format!("{base}{}", music_chain(spec, source.duration, duration)?)
            }
            _ => return Err("不支持的音频操作。".into()),
        };
        let temporary = workspace.path().join("output.wav");
        let start = if action == "normalize" { 0.4 } else { 0.0 };
        let span = if action == "normalize" { 0.4 } else { 1.0 };
        self.encode(
            id,
            runtime,
            source,
            &filter,
            duration,
            Some(&temporary),
            workspace.path(),
            cancelled,
            start,
            span,
            "正在生成处理后的音频",
        )?;
        check_cancelled(cancelled)?;
        let mut after = None;
        if action == "normalize" {
            let output_source = AudioSource {
                path: temporary.clone(),
                trim_in: 0.0,
                trim_out: duration,
                speed: 1.0,
                duration,
                looping: false,
                volume: 1.0,
            };
            let logs = self.encode(
                id,
                runtime,
                &output_source,
                &analysis_filter(&output_source.chain(), target_i, target_tp),
                duration,
                None,
                workspace.path(),
                cancelled,
                0.8,
                0.2,
                "正在验证最终响度",
            )?;
            let measured = loudness(&logs, duration)?;
            if measured.tp.is_some_and(|peak| peak > target_tp + 0.3) {
                return Err("处理后的真峰值超出设定，未替换原片段。".into());
            }
            after = Some(measured.public());
        }
        check_cancelled(cancelled)?;
        let output = store.root.join(format!("audio-tool-{id}.wav"));
        fs::copy(&temporary, &output).map_err(|error| format!("保存音频失败：{error}"))?;
        let result = (|| {
            check_cancelled(cancelled)?;
            let asset = store.probe(runtime, &output, "处理后的音频.wav")?;
            if asset.kind != "audio" || asset.duration <= 0.0 || asset.size == 0 {
                return Err("音频结果无效。".into());
            }
            Ok(
                json!({"asset":asset,"before":before.map(|value|value.public()),"after":after,"method":if action=="ducking" {"timeline-speech-intervals"} else if action=="music_fit" {"beat-window-loop-with-edge-fades"} else {"offline-filter"},"duration":duration}),
            )
        })();
        match result {
            Ok(value) => Ok((value, Some(output))),
            Err(error) => {
                let _ = fs::remove_file(output);
                Err(error)
            }
        }
    }
    #[allow(clippy::too_many_arguments)]
    fn encode(
        &self,
        id: &str,
        runtime: &Runtime,
        source: &AudioSource,
        filter: &str,
        duration: f64,
        output: Option<&Path>,
        workspace: &Path,
        cancelled: &AtomicBool,
        offset: f64,
        span: f64,
        stage: &str,
    ) -> Result<String> {
        check_cancelled(cancelled)?;
        self.progress(id, offset, stage);
        let script = workspace.join("filters.txt");
        fs::write(&script, format!("[0:a:0]{filter}[out]")).map_err(|error| error.to_string())?;
        let mut command = engine::process(&runtime.encoder);
        command.args([
            "-hide_banner",
            "-nostdin",
            "-y",
            "-progress",
            "pipe:1",
            "-nostats",
        ]);
        if source.looping {
            command.args(["-stream_loop", "-1"]);
        }
        command
            .arg("-i")
            .arg(&source.path)
            .arg("-filter_complex_script")
            .arg(&script)
            .args(["-map", "[out]", "-vn", "-t"])
            .arg(duration.to_string());
        if let Some(output) = output {
            command
                .args(["-ar", "48000", "-ac", "2", "-c:a", "pcm_s24le"])
                .arg(output);
        } else {
            command.args(["-f", "null", "-"]);
        }
        let mut child = command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("无法启动内置音频引擎：{error}"))?;
        let stderr = child.stderr.take().ok_or("无法读取音频引擎错误。")?;
        let log_thread = thread::spawn(move || {
            let mut reader = stderr;
            let mut bytes = Vec::new();
            let mut buffer = [0u8; 8192];
            while let Ok(count) = reader.read(&mut buffer) {
                if count == 0 {
                    break;
                }
                if bytes.len() < 2_000_000 {
                    bytes.extend_from_slice(&buffer[..count.min(2_000_000 - bytes.len())]);
                }
            }
            String::from_utf8_lossy(&bytes).into_owned()
        });
        let stdout = child.stdout.take().ok_or("无法读取音频处理进度。")?;
        let manager = self.clone();
        let job_id = id.to_owned();
        let stage = stage.to_owned();
        let progress_thread = thread::spawn(move || {
            for line in BufReader::new(stdout)
                .lines()
                .map_while(std::result::Result::ok)
            {
                if let Some(value) = line
                    .strip_prefix("out_time_us=")
                    .and_then(|v| v.parse::<f64>().ok())
                {
                    manager.progress(
                        &job_id,
                        offset + span * (value / 1_000_000.0 / duration).clamp(0.0, 1.0),
                        &stage,
                    );
                }
            }
        });
        let status = loop {
            if cancelled.load(Ordering::SeqCst) {
                let _ = child.kill();
                let _ = child.wait();
                let _ = progress_thread.join();
                let _ = log_thread.join();
                return Err("音频处理已取消。".into());
            }
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) => thread::sleep(Duration::from_millis(30)),
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = progress_thread.join();
                    let _ = log_thread.join();
                    return Err(format!("无法读取音频引擎状态：{error}"));
                }
            }
        };
        let _ = progress_thread.join();
        let logs = log_thread.join().unwrap_or_default();
        if !status.success() {
            return Err(format!(
                "音频引擎处理失败：{}",
                logs.chars()
                    .rev()
                    .take(1800)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect::<String>()
            ));
        }
        Ok(logs)
    }
}
fn check_cancelled(value: &AtomicBool) -> Result<()> {
    if value.load(Ordering::SeqCst) {
        Err("音频处理已取消。".into())
    } else {
        Ok(())
    }
}
fn number(value: &Value, key: &str, default: f64, min: f64, max: f64) -> Result<f64> {
    let number = match value.get(key) {
        Some(value) => value
            .as_f64()
            .ok_or_else(|| format!("{key} 必须是数字。"))?,
        None => default,
    };
    if !number.is_finite() || number < min || number > max {
        return Err(format!("{key} 应在 {min} 到 {max} 之间。"));
    }
    Ok(number)
}
struct AudioSource {
    path: PathBuf,
    trim_in: f64,
    trim_out: f64,
    speed: f64,
    duration: f64,
    looping: bool,
    volume: f64,
}
impl AudioSource {
    fn parse(store: &MediaStore, spec: &Value) -> Result<Self> {
        let asset = &spec["asset"];
        if asset["kind"] != "audio" {
            return Err("请选择音频轨道中的音频片段。".into());
        }
        let path = store.authorized_path(asset)?;
        let asset_duration = number(asset, "duration", 0.0, 0.001, 86400.0)?;
        let trim_in = number(spec, "trimIn", 0.0, 0.0, 86400.0)?;
        let trim_out = number(spec, "trimOut", asset_duration, 0.001, 86400.0)?;
        let speed = number(spec, "speed", 1.0, 0.1, 16.0)?;
        let duration = (trim_out - trim_in) / speed;
        if duration <= 0.0 || duration > 86400.0 {
            return Err("音频片段时长无效。".into());
        }
        Ok(Self {
            path,
            trim_in,
            trim_out,
            speed,
            duration,
            looping: trim_out > asset_duration + 0.001,
            volume: number(spec, "volume", 1.0, 0.0, 4.0)?,
        })
    }
    fn chain(&self) -> String {
        let mut speed = self.speed;
        let mut parts = vec![
            format!("atrim=start={}:end={}", self.trim_in, self.trim_out),
            "asetpts=PTS-STARTPTS".into(),
            "aresample=48000".into(),
        ];
        while speed > 2.0 {
            parts.push("atempo=2".into());
            speed /= 2.0;
        }
        while speed < 0.5 {
            parts.push("atempo=0.5".into());
            speed /= 0.5;
        }
        if (speed - 1.0).abs() > 1e-9 {
            parts.push(format!("atempo={speed}"));
        }
        parts.push(format!("volume={}", self.volume));
        parts.join(",")
    }
}
#[derive(Debug)]
struct Loudness {
    i: Option<f64>,
    tp: Option<f64>,
    lra: Option<f64>,
    threshold: Option<f64>,
    offset: Option<f64>,
    peak: Option<f64>,
    silence_intervals: Vec<Value>,
    duration: f64,
}
impl Loudness {
    fn public(&self) -> Value {
        let possible_clipping =
            self.peak.is_some_and(|peak| peak >= -0.1) || self.tp.is_some_and(|peak| peak >= 0.0);
        json!({"integratedLufs":self.i,"truePeakDbtp":self.tp,"loudnessRange":self.lra,"thresholdLufs":self.threshold,"silent":self.peak.is_none() && self.tp.is_none(),"measured":true,
            "peakDbfs":self.peak,"possibleClipping":possible_clipping,"silenceIntervals":self.silence_intervals,"analyzedDuration":self.duration,"timeOrigin":"clip",
            "evidence":{"detector":"loudnorm/astats/silencedetect","clippingWarningThresholdDbfs":-0.1,"truePeakWarningThresholdDbtp":0.0,"silenceThresholdDbfs":-50.0,"minimumSilenceDuration":0.25,"processing":"trim-speed-volume-before-fades","clippingAssessment":"peak-risk"},
            "note":"峰值接近数字满幅仅提示削波风险，不是已确认削波；静音按阈值检测，不代表该时段一定需要删除。"})
    }
}
fn analysis_filter(base: &str, target_i: f64, target_tp: f64) -> String {
    format!("{base},silencedetect=noise=-50dB:d=0.25,astats=metadata=0:reset=0:measure_perchannel=none:measure_overall=Peak_level,loudnorm=I={target_i}:TP={target_tp}:LRA=11:print_format=json")
}
fn log_number(line: &str, key: &str) -> Option<f64> {
    line.split_once(key)?
        .1
        .split_whitespace()
        .next()?
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
}
fn loudness(logs: &str, duration: f64) -> Result<Loudness> {
    let end = logs.rfind('}').ok_or("音频引擎没有返回响度测量结果。")?;
    let start = logs[..end].rfind('{').ok_or("响度测量格式无效。")?;
    let value: Value =
        serde_json::from_str(&logs[start..=end]).map_err(|_| "响度测量格式无效。")?;
    let field = |key: &str| {
        value[key]
            .as_str()
            .and_then(|text| text.parse::<f64>().ok())
            .filter(|number| number.is_finite())
    };
    if !value["input_i"].is_string() {
        return Err("响度测量缺少综合响度。".into());
    }
    let mut peak: Option<f64> = None;
    let mut silence_start: Option<f64> = None;
    let mut silence_intervals = Vec::new();
    let mut push_silence = |start: f64, end: f64| {
        let start = start.clamp(0.0, duration);
        let end = end.clamp(0.0, duration);
        if end - start >= 0.25 - 0.002 {
            silence_intervals.push(json!({"start":start,"end":end,"duration":end-start}));
        }
    };
    for line in logs.lines() {
        if let Some(value) = log_number(line, "Peak level dB:") {
            peak = Some(peak.map_or(value, |old| old.max(value)));
        }
        if line.contains("silencedetect") {
            if let Some(value) = log_number(line, "silence_start:") {
                silence_start = Some(value);
            }
            if let Some(end) = log_number(line, "silence_end:") {
                if let Some(start) = silence_start.take() {
                    push_silence(start, end);
                }
            }
        }
    }
    if let Some(start) = silence_start {
        push_silence(start, duration);
    }
    Ok(Loudness {
        peak,
        silence_intervals,
        duration,
        i: field("input_i"),
        tp: field("input_tp"),
        lra: field("input_lra"),
        threshold: field("input_thresh"),
        offset: field("target_offset"),
    })
}
fn processing_chain(spec: &Value) -> Result<String> {
    let mut filters = Vec::new();
    let denoise = number(spec, "denoise", 0.0, 0.0, 1.0)?;
    if denoise > 0.0 {
        filters.push(format!("afftdn=nr={}:nf=-45:tn=1", denoise * 24.0 + 1.0));
    }
    for (key, freq) in [("lowGain", 120), ("midGain", 1000), ("highGain", 8000)] {
        let gain = number(&spec["eq"], key, 0.0, -18.0, 18.0)?;
        if gain != 0.0 {
            filters.push(format!("equalizer=f={freq}:t=q:w=0.7:g={gain}"));
        }
    }
    for key in ["compress", "limiter"] {
        if spec.get(key).is_some_and(|v| !v.is_boolean()) {
            return Err("音频处理开关必须为布尔值。".into());
        }
    }
    if spec["compress"] == true {
        filters.push("acompressor=threshold=0.125:ratio=3:attack=15:release=200:makeup=1.5".into());
    }
    let deess = number(spec, "deess", 0.0, 0.0, 1.0)?;
    if deess > 0.0 {
        filters.push(format!("deesser=i={deess}:m=0.5:f=0.5:s=o"));
    }
    if spec["limiter"] == true {
        filters.push("alimiter=limit=0.891250938:attack=5:release=50:level=false".into());
    }
    if filters.is_empty() {
        return Err("请至少启用一项音频处理。".into());
    }
    Ok(format!(",{}", filters.join(",")))
}
fn ducking_expression(spec: &Value, duration: f64) -> Result<String> {
    let intervals = spec["intervals"].as_array().ok_or("缺少人声时间区间。")?;
    if intervals.is_empty() || intervals.len() > 256 {
        return Err("人声区间应为 1 到 256 段，请合并相邻人声片段。".into());
    }
    let attack = number(spec, "attack", 0.1, 0.005, 5.0)?;
    let release = number(spec, "release", 0.3, 0.005, 5.0)?;
    let reduction = number(spec, "reductionDb", 12.0, 0.0, 48.0)?;
    let gain = 10.0_f64.powf(-reduction / 20.0);
    let mut envelopes = Vec::new();
    for interval in intervals {
        let start = number(interval, "start", -1.0, 0.0, duration)?;
        let end = number(interval, "end", -1.0, 0.0, duration)?;
        if end <= start {
            return Err("人声区间结束必须晚于开始。".into());
        }
        envelopes.push(format!(
            "max(0,min(1,min((t-{})/{attack},({}-t)/{release})))",
            start - attack,
            end + release
        ));
    }
    let envelope = envelopes
        .into_iter()
        .reduce(|a, b| format!("max({a},{b})"))
        .unwrap();
    Ok(format!("1-(1-{gain})*({envelope})"))
}
fn music_chain(spec: &Value, source_duration: f64, duration: f64) -> Result<String> {
    let fade = number(spec, "fadeOut", 2.0, 0.0, 30.0)?.min(duration);
    let mut filters = Vec::new();
    if duration > source_duration + 1e-6 {
        let mut window = source_duration;
        if spec.get("bpm").is_some() {
            let bpm = number(spec, "bpm", 120.0, 20.0, 300.0)?;
            let bar = 240.0 / bpm;
            if source_duration >= bar {
                window = (source_duration / bar).floor() * bar;
            } else {
                return Err("音乐片段不足一个四拍小节，请取消BPM或使用更长素材。".into());
            }
        }
        let samples = (window * 48000.0).round() as u64;
        if samples < 480 {
            return Err("音乐循环区间过短。".into());
        }
        let edge = 0.008_f64.min(window / 10.0);
        filters.push(format!("atrim=duration={window},afade=t=in:st=0:d={edge},afade=t=out:st={}:d={edge},aloop=loop=-1:size={samples},atrim=duration={duration}",window-edge));
    } else {
        filters.push(format!("atrim=duration={duration}"));
    }
    if fade > 0.0 {
        filters.push(format!("afade=t=out:st={}:d={fade}", duration - fade));
    }
    Ok(format!(",{}", filters.join(",")))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn silence_is_not_fabricated_loudness() {
        let result=loudness("log\n{\"input_i\":\"-inf\",\"input_tp\":\"-inf\",\"input_lra\":\"0.0\",\"input_thresh\":\"-70.0\",\"target_offset\":\"inf\"}\n", 1.0).unwrap();
        assert!(result.i.is_none());
        assert_eq!(result.public()["silent"], true);
    }
    #[test]
    fn invalid_processing_inputs_rejected() {
        assert!(processing_chain(&json!({})).is_err());
        assert!(processing_chain(&json!({"denoise":2})).is_err());
        assert!(processing_chain(&json!({"compress":"yes"})).is_err());
        assert!(processing_chain(&json!({"eq":{"lowGain":40}})).is_err());
    }
    #[test]
    fn loops_use_whole_bars_when_requested() {
        let chain = music_chain(&json!({"bpm":120,"fadeOut":2}), 5.4, 13.0).unwrap();
        assert!(chain.contains("atrim=duration=4"));
        assert!(chain.contains("size=192000"));
        assert!(chain.contains("st=11"));
    }
    #[test]
    fn real_ducking_reaches_speech_boundaries_without_packet_delay() {
        let Ok(runtime) = Runtime::discover(None, None) else { return; };
        let root = tempfile::tempdir().unwrap();
        let store = MediaStore::new(root.path()).unwrap();
        let source = root.path().join("steady.wav");
        let status = engine::process(&runtime.encoder)
            .args(["-hide_banner", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "aevalsrc=0.5:d=2:s=48000", "-c:a", "pcm_s24le"])
            .arg(&source).status().unwrap();
        assert!(status.success());
        let asset = serde_json::to_value(store.import(&runtime, &source, Some("steady.wav")).unwrap()).unwrap();
        let manager = AudioToolsManager::default();
        let started = manager.begin(&runtime, &store, json!({"action":"ducking", "asset":asset, "intervals":[{"start":0.5,"end":1.2}], "attack":0.02,"release":0.02,"reductionDb":12})).unwrap();
        let deadline = Instant::now() + Duration::from_secs(30);
        let completed = loop {
            let job = manager.get(&started.id).unwrap();
            if job.state != "running" { break job; }
            assert!(Instant::now() < deadline, "ducking job timeout");
            thread::sleep(Duration::from_millis(20));
        };
        assert_eq!(completed.state, "completed", "{:?}", completed.error);
        let result = completed.result.unwrap();
        let output = engine::process(&runtime.encoder)
            .args(["-hide_banner", "-nostdin", "-loglevel", "error", "-i", result["asset"]["nativePath"].as_str().unwrap(), "-ac", "1", "-f", "f32le", "-"])
            .output().unwrap();
        assert!(output.status.success());
        let samples: Vec<f32> = output.stdout.chunks_exact(4).map(|bytes| f32::from_le_bytes(bytes.try_into().unwrap())).collect();
        let sample = |time: f64| samples[(time * 48000.0).round() as usize] as f64;
        let base = sample(0.1);
        let ratio = |time| sample(time) / base;
        assert!((ratio(0.50) - 10.0_f64.powf(-12.0 / 20.0)).abs() < 0.015, "music must be low at speech start");
        assert!((ratio(1.22) - 1.0).abs() < 0.015, "music must recover at the configured release boundary");
        assert!(ratio(0.49) > 0.4 && ratio(0.49) < 0.85, "attack should be gradual");
        assert!(ratio(1.21) > 0.4 && ratio(1.21) < 0.85, "release should be gradual");
        manager.discard(&started.id).unwrap();
    }
    #[test]
    fn real_timeline_music_automation_uses_bounded_frames_at_source_sample_rates() {
        let Ok(runtime) = Runtime::discover(None, None) else { return; };
        for sample_rate in [16000, 44100] {
            let root = tempfile::tempdir().unwrap();
            let store = MediaStore::new(root.path()).unwrap();
            let source = root.path().join("music.wav");
            assert!(engine::process(&runtime.encoder)
                .args(["-hide_banner", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", &format!("aevalsrc=0.25:d=2:s={sample_rate}"), "-c:a", "pcm_s24le"])
                .arg(&source).status().unwrap().success());
            let asset = serde_json::to_value(store.import(&runtime, &source, Some("music.wav")).unwrap()).unwrap();
            let spec = json!({"kind":"timeline","project":{"width":64,"height":48,"fps":20,"background":"#000000","assets":[asset],"tracks":[{"kind":"audio","muted":false,"clips":[{"id":"bed","assetId":asset["id"],"start":0,"trimIn":0,"trimOut":2,"speed":1,"volume":1,"fadeIn":0,"fadeOut":0,"keyframes":{"volume":[{"time":0,"value":1},{"time":0.48,"value":1},{"time":0.5,"value":0.25},{"time":1.2,"value":0.25},{"time":1.22,"value":1},{"time":2,"value":1}]}}]}]},"config":{"format":"mov","width":64,"height":48,"fps":20,"quality":"high"}});
            let plan = engine::build_plan(&store, &runtime, &spec).unwrap();
            let output = root.path().join("render.mov");
            let result = engine::process(&runtime.encoder).args(["-v", "error", "-y", "-filter_complex_threads", "1"])
                .args(&plan.args).args(["-threads", "1", "-c:a", "pcm_s24le"]).arg(&output).output().unwrap();
            assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
            let decoded = engine::process(&runtime.encoder).args(["-v", "error", "-i"]).arg(&output)
                .args(["-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "-"]).output().unwrap();
            assert!(decoded.status.success());
            let samples: Vec<f32> = decoded.stdout.chunks_exact(4).map(|bytes| f32::from_le_bytes(bytes.try_into().unwrap())).collect();
            let sample = |time: f64| samples[(time * 48000.0).round() as usize] as f64;
            let base = sample(0.1);
            // The final limiter adds its existing five millisecond lookahead delay.
            assert!((sample(0.511) / base - 0.25).abs() < 0.04, "source {sample_rate}: music attack was delayed");
            assert!((sample(1.231) / base - 1.0).abs() < 0.04, "source {sample_rate}: music release was delayed");
        }
    }
    #[test]
    fn real_loudness_normalize_duck_and_loop() {
        let Ok(runtime) = Runtime::discover(None, None) else {
            return;
        };
        let root = tempfile::tempdir().unwrap();
        let store = MediaStore::new(root.path()).unwrap();
        let input = root.path().join("source.wav");
        let status = engine::process(&runtime.encoder)
            .args([
                "-hide_banner",
                "-nostdin",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=2:sample_rate=48000",
                "-af",
                "volume=0.25",
                "-c:a",
                "pcm_s16le",
            ])
            .arg(&input)
            .status()
            .unwrap();
        assert!(status.success());
        let asset =
            serde_json::to_value(store.import(&runtime, &input, Some("source.wav")).unwrap())
                .unwrap();
        let manager = AudioToolsManager::default();
        fn wait(manager: &AudioToolsManager, id: &str) -> AudioToolJob {
            let until = Instant::now() + Duration::from_secs(30);
            loop {
                let job = manager.get(id).unwrap();
                if job.state != "running" {
                    return job;
                }
                assert!(Instant::now() < until, "audio job timeout");
                thread::sleep(Duration::from_millis(20));
            }
        }
        let analysis = manager
            .begin(&runtime, &store, json!({"action":"analyze","asset":asset}))
            .unwrap();
        let measured = wait(&manager, &analysis.id);
        assert_eq!(measured.state, "completed", "{:?}", measured.error);
        assert!(measured.result.unwrap()["integratedLufs"].as_f64().unwrap() < -25.0);
        let normalized = manager
            .begin(
                &runtime,
                &store,
                json!({"action":"normalize","asset":asset,"targetLufs":-18,"truePeak":-1}),
            )
            .unwrap();
        let normalized = wait(&manager, &normalized.id);
        assert_eq!(normalized.state, "completed", "{:?}", normalized.error);
        let result = normalized.result.unwrap();
        assert!((result["after"]["integratedLufs"].as_f64().unwrap() + 18.0).abs() < 1.0);
        assert!(result["after"]["truePeakDbtp"].as_f64().unwrap() <= -0.7);
        manager.discard(&normalized.id).unwrap();
        for spec in [
            json!({"action":"process","asset":asset,"denoise":0.3,"eq":{"lowGain":2,"highGain":-2},"compress":true,"deess":0.3,"limiter":true}),
            json!({"action":"ducking","asset":asset,"intervals":[{"start":0.5,"end":1.2}]}),
            json!({"action":"music_fit","asset":asset,"duration":5.0,"bpm":120,"fadeOut":0.5}),
        ] {
            let action = spec["action"].as_str().unwrap().to_owned();
            let started = manager.begin(&runtime, &store, spec).unwrap();
            let done = wait(&manager, &started.id);
            assert_eq!(done.state, "completed", "{:?}", done.error);
            let output = done.result.unwrap();
            assert!(output["asset"]["size"].as_u64().unwrap() > 1000);
            let output_path = output["asset"]["nativePath"].as_str().unwrap();
            if action == "ducking" {
                let mean = |start: &str| {
                    let output = engine::process(&runtime.encoder)
                        .args([
                            "-hide_banner",
                            "-nostdin",
                            "-ss",
                            start,
                            "-t",
                            "0.2",
                            "-i",
                            output_path,
                            "-af",
                            "volumedetect",
                            "-f",
                            "null",
                            "-",
                        ])
                        .output()
                        .unwrap();
                    assert!(output.status.success());
                    let logs = String::from_utf8_lossy(&output.stderr);
                    logs.lines()
                        .find_map(|line| {
                            line.split_once("mean_volume: ")
                                .and_then(|(_, value)| value.split_whitespace().next())
                                .and_then(|value| value.parse::<f64>().ok())
                        })
                        .unwrap()
                };
                assert!(
                    mean("0.1") - mean("0.7") > 10.0,
                    "speech interval must audibly reduce background"
                );
            }
            if action == "music_fit" {
                assert!((output["asset"]["duration"].as_f64().unwrap() - 5.0).abs() < 0.02);
            }
            manager.discard(&started.id).unwrap();
            assert!(!Path::new(output_path).exists());
        }
        let cancelled = manager
            .begin(
                &runtime,
                &store,
                json!({"action":"music_fit","asset":asset,"duration":86400.0}),
            )
            .unwrap();
        manager.cancel(&cancelled.id).unwrap();
        let cancelled = wait(&manager, &cancelled.id);
        assert_eq!(cancelled.state, "cancelled");
        assert!(cancelled.result.is_none());
        assert!(!store
            .root
            .join(format!("audio-tool-{}.wav", cancelled.id))
            .exists());
    }
    #[test]
    fn real_analysis_reports_silence_and_full_scale_peak_after_clip_processing() {
        let Ok(runtime) = Runtime::discover(None, None) else {
            return;
        };
        let root = tempfile::tempdir().unwrap();
        let store = MediaStore::new(root.path()).unwrap();
        let input = root.path().join("silence-and-full-scale.wav");
        let status = engine::process(&runtime.encoder)
            .args([
                "-hide_banner",
                "-nostdin",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "aevalsrc=sin(2*PI*440*t)*between(t\\,0.5\\,1.5):s=48000:d=2",
                "-c:a",
                "pcm_f32le",
            ])
            .arg(&input)
            .status()
            .unwrap();
        assert!(status.success());
        let asset = serde_json::to_value(
            store
                .import(&runtime, &input, Some("full-scale.wav"))
                .unwrap(),
        )
        .unwrap();
        let manager = AudioToolsManager::default();
        let analyze = |extra: Value| {
            let mut spec = json!({"action":"analyze","asset":asset});
            spec.as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            let job = manager.begin(&runtime, &store, spec).unwrap();
            let until = Instant::now() + Duration::from_secs(30);
            loop {
                let job = manager.get(&job.id).unwrap();
                if job.state != "running" {
                    assert_eq!(job.state, "completed", "{:?}", job.error);
                    break job.result.unwrap();
                }
                assert!(Instant::now() < until);
                thread::sleep(Duration::from_millis(20));
            }
        };
        let measured = analyze(json!({}));
        assert_eq!(measured["possibleClipping"], true);
        assert!(measured["peakDbfs"].as_f64().unwrap() >= -0.1);
        assert_eq!(measured["evidence"]["clippingAssessment"], "peak-risk");
        let intervals = measured["silenceIntervals"].as_array().unwrap();
        assert_eq!(intervals.len(), 2, "{measured}");
        assert!((intervals[0]["end"].as_f64().unwrap() - 0.5).abs() < 0.01);
        assert!((intervals[1]["start"].as_f64().unwrap() - 1.5).abs() < 0.01);
        assert!((intervals[1]["end"].as_f64().unwrap() - 2.0).abs() < 0.01);
        let quiet = analyze(json!({"volume":0.1}));
        assert_eq!(quiet["possibleClipping"], false);
        assert!((quiet["peakDbfs"].as_f64().unwrap() + 20.0).abs() < 0.1);
        // This crop removes the leading silence; slowing it doubles the trailing silence.
        let adjusted = analyze(json!({"trimIn":0.5,"trimOut":2.0,"speed":0.5,"volume":0.1}));
        assert_eq!(adjusted["timeOrigin"], "clip");
        assert!((adjusted["analyzedDuration"].as_f64().unwrap() - 3.0).abs() < 0.01);
        let intervals = adjusted["silenceIntervals"].as_array().unwrap();
        assert_eq!(intervals.len(), 1, "{adjusted}");
        assert!((intervals[0]["start"].as_f64().unwrap() - 2.0).abs() < 0.08);
        assert!((intervals[0]["end"].as_f64().unwrap() - 3.0).abs() < 0.08);
        // Loudness gating can be unavailable on a very short audible clip;
        // absent LUFS alone must not falsely classify it as silent.
        let short = analyze(json!({"trimIn":0.5,"trimOut":0.6,"volume":0.1}));
        assert_eq!(short["silent"], false);
        assert!(short["peakDbfs"].as_f64().is_some());
        let silent = analyze(json!({"volume":0.0}));
        assert_eq!(silent["silent"], true);
        assert_eq!(silent["possibleClipping"], false);
        assert_eq!(silent["silenceIntervals"].as_array().unwrap().len(), 1);
    }
}
