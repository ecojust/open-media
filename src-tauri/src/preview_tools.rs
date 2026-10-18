//! Temporary range previews share the production composition graph and job lifecycle.
use crate::engine::{self, Asset, JobManager, MediaJob, MediaStore, RenderPlan, Result, Runtime};
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    thread,
    time::{Duration, Instant},
};

const PREFIX: &str = "tool-preview-";
fn scalar(spec: &Value, key: &str, default: Option<f64>, low: f64, high: f64) -> Result<f64> {
    let value = spec
        .get(key)
        .map_or(default, Value::as_f64)
        .ok_or_else(|| format!("预览参数 {key} 无效。"))?;
    if !value.is_finite() || value < low || value > high {
        return Err(format!("预览参数 {key} 超出范围。"));
    }
    Ok(value)
}
fn check_root(store: &MediaStore) -> Result<PathBuf> {
    let root = store.root.canonicalize().map_err(|e| e.to_string())?;
    let meta = fs::symlink_metadata(&store.root).map_err(|e| e.to_string())?;
    if root != store.root || !meta.is_dir() || meta.file_type().is_symlink() {
        return Err("素材库目录已发生变化。".into());
    }
    Ok(root)
}
fn preview_name(name: &str) -> bool {
    let Some(name) = name.strip_prefix(PREFIX) else {
        return false;
    };
    let Some((id, extension)) = name.rsplit_once('.') else {
        return false;
    };
    id.len() == 32
        && id.bytes().all(|c| c.is_ascii_hexdigit())
        && matches!(extension, "mp4" | "wav")
}
fn owned_job(store: &MediaStore, jobs: &JobManager, id: &str) -> Result<(MediaJob, PathBuf)> {
    let job = jobs
        .list()
        .into_iter()
        .find(|job| job.id == id)
        .ok_or("预览任务不存在。")?;
    if !preview_name(&job.name) {
        return Err("该任务不是临时预览。".into());
    }
    let output = check_root(store)?.join(&job.name);
    if let Some(path) = &job.output_path {
        if PathBuf::from(path) != output {
            return Err("预览路径不属于当前素材库。".into());
        }
    }
    match fs::symlink_metadata(&output) {
        Ok(meta) => {
            if !meta.is_file()
                || meta.file_type().is_symlink()
                || output.canonicalize().map_err(|e| e.to_string())? != output
            {
                return Err("临时预览文件路径无效。".into());
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.to_string()),
    }
    Ok((job, output))
}
fn make_plan(store: &MediaStore, runtime: &Runtime, spec: &Value) -> Result<RenderPlan> {
    let start = scalar(spec, "start", None, 0.0, 86400.0)?;
    let end = scalar(spec, "end", None, 0.001, 86400.0)?;
    if end <= start || end - start > 60.0 + 1e-6 {
        return Err("预览区间需大于零且最多 60 秒。".into());
    }
    let project = spec
        .get("project")
        .filter(|p| p.is_object())
        .ok_or("缺少预览工程。")?;
    let source_width = project["width"]
        .as_f64()
        .filter(|v| v.is_finite() && *v >= 16.0 && *v <= 16384.0)
        .ok_or("工程画面宽度无效。")?;
    let source_height = project["height"]
        .as_f64()
        .filter(|v| v.is_finite() && *v >= 16.0 && *v <= 16384.0)
        .ok_or("工程画面高度无效。")?;
    let requested = scalar(spec, "width", Some(source_width.min(640.0)), 16.0, 1280.0)?;
    let scale = (requested / source_width)
        .min(1280.0 / source_height)
        .min(1.0);
    let even = |n: f64| ((n.round() as u32 / 2) * 2).max(16);
    let width = even(source_width * scale);
    let height = even(source_height * scale);
    let fps = scalar(
        spec,
        "fps",
        Some(project["fps"].as_f64().unwrap_or(24.0).min(30.0)),
        1.0,
        30.0,
    )?;
    let audio_only = match spec.get("audioOnly") {
        None => false,
        Some(v) => v.as_bool().ok_or("音频预览开关无效。")?,
    };
    let mut plan = engine::build_plan(
        store,
        runtime,
        &json!({ "kind":"timeline", "project":project, "audioOnly":audio_only, "textAssets":spec.get("textAssets").cloned().unwrap_or_else(||json!({})), "config":{"format":"mp4","width":width,"height":height,"fps":fps,"quality":"draft"} }),
    )?;
    if start >= plan.duration || end > plan.duration + 1e-6 {
        return Err("预览区间超出工程时长。".into());
    }
    if audio_only {
        let script_index = plan
            .args
            .iter()
            .position(|v| v == "-filter_complex_script")
            .ok_or("预览合成图缺失。")?
            + 1;
        let script = PathBuf::from(plan.args.get(script_index).ok_or("预览合成图无效。")?);
        if !script.starts_with(plan.workspace.path()) {
            return Err("预览合成图不属于当前任务。".into());
        }
        let mut graph = fs::read_to_string(&script).map_err(|e| e.to_string())?;
        graph.push_str(";[video]nullsink");
        let has_audio = plan
            .args
            .windows(2)
            .any(|pair| pair[0] == "-map" && pair[1] == "[audio]");
        if !has_audio {
            graph.push_str(&format!(
                ";anullsrc=r=48000:cl=stereo,atrim=duration={}[audio]",
                plan.duration
            ));
        }
        fs::write(script, graph).map_err(|e| e.to_string())?;
        let first_map = plan
            .args
            .iter()
            .position(|v| v == "-map")
            .ok_or("预览输出流缺失。")?;
        plan.args.truncate(first_map);
        plan.args.extend(
            [
                "-map",
                "[audio]",
                "-c:a",
                "pcm_s16le",
                "-ar",
                "48000",
                "-ac",
                "2",
                "-vn",
            ]
            .map(str::to_owned),
        );
        plan.format = "wav".into();
        plan.video = None;
    }
    // Output seeking retains every upstream compositing and audio filter, including
    // effects that begin before the requested range. Encoding is bounded to 60 s.
    plan.args.extend([
        "-ss".into(),
        start.to_string(),
        "-t".into(),
        (end - start).to_string(),
    ]);
    plan.duration = end - start;
    Ok(plan)
}
pub fn begin(
    store: &MediaStore,
    runtime: &Runtime,
    jobs: &JobManager,
    spec: &Value,
) -> Result<MediaJob> {
    let root = check_root(store)?;
    let plan = make_plan(store, runtime, spec)?;
    let name = format!("{PREFIX}{}.{}", engine::new_id(), plan.format);
    jobs.begin_with_overwrite(runtime, plan, root.join(name), false)
}
pub fn result(store: &MediaStore, runtime: &Runtime, jobs: &JobManager, id: &str) -> Result<Asset> {
    let (job, path) = owned_job(store, jobs, id)?;
    if job.state != "completed" {
        return Err(job.error.unwrap_or_else(|| "预览尚未完成。".into()));
    }
    let mut asset = store.probe(
        runtime,
        &path,
        if path.extension().is_some_and(|e| e == "wav") {
            "音频预览.wav"
        } else {
            "区间预览.mp4"
        },
    )?;
    asset.id = format!("preview-{id}");
    Ok(asset)
}
pub fn discard(store: &MediaStore, jobs: &JobManager, id: &str) -> Result<()> {
    let (job, path) = owned_job(store, jobs, id)?;
    if job.state == "running" {
        jobs.cancel(id)?;
        let jobs = jobs.clone();
        let store = store.clone();
        let id = id.to_owned();
        thread::Builder::new()
            .name("preview-cleanup".into())
            .spawn(move || {
                let deadline = Instant::now() + Duration::from_secs(60);
                while Instant::now() < deadline {
                    match owned_job(&store, &jobs, &id) {
                        Ok((job, path)) if job.state != "running" => {
                            let _ = fs::remove_file(path);
                            return;
                        }
                        Ok(_) => thread::sleep(Duration::from_millis(50)),
                        Err(_) => return,
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn runtime() -> Runtime {
        Runtime::discover(None, None).expect("real media tools are required")
    }
    fn finish(jobs: &JobManager, id: &str) -> MediaJob {
        let deadline = Instant::now() + Duration::from_secs(90);
        loop {
            let job = jobs.list().into_iter().find(|j| j.id == id).unwrap();
            if job.state != "running" {
                assert_eq!(job.state, "completed", "{:?}", job.error);
                return job;
            }
            assert!(Instant::now() < deadline, "preview timeout");
            thread::sleep(Duration::from_millis(25));
        }
    }
    fn fixture(store: &MediaStore, runtime: &Runtime) -> Value {
        let video = store.root.join("source.mp4");
        let status = engine::process(&runtime.encoder)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=red:s=160x90:r=20:d=1",
                "-f",
                "lavfi",
                "-i",
                "color=c=blue:s=160x90:r=20:d=2",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=3:sample_rate=48000",
                "-filter_complex",
                "[0:v][1:v]concat=n=2:v=1:a=0[v]",
                "-map",
                "[v]",
                "-map",
                "2:a",
                "-c:v",
                "libx264",
                "-threads",
                "1",
                "-c:a",
                "aac",
                "-y",
            ])
            .arg(&video)
            .status()
            .unwrap();
        assert!(status.success());
        let asset = store.probe(runtime, &video, "source.mp4").unwrap();
        let overlay = store.root.join("overlay.png");
        let status = engine::process(&runtime.encoder)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=0x00ff00:s=40x40",
                "-frames:v",
                "1",
                "-threads",
                "1",
                "-y",
            ])
            .arg(&overlay)
            .status()
            .unwrap();
        assert!(status.success());
        let title = store.probe(runtime, &overlay, "overlay.png").unwrap();
        json!({"project":{"width":160,"height":90,"fps":20,"background":"#000000","assets":[asset],"tracks":[{"kind":"text","clips":[{"id":"title","start":1,"trimIn":0,"trimOut":1,"speed":1,"width":40,"height":40,"x":10,"y":10,"opacity":1,"volume":0}]},{"kind":"video","muted":false,"clips":[{"id":"video","assetId":asset.id,"start":0,"trimIn":0,"trimOut":3,"speed":1,"width":160,"height":90,"x":0,"y":0,"volume":0.4,"opacity":1}]}]},"textAssets":{"title":title},"start":1.2,"end":1.8,"width":160,"fps":20})
    }
    #[test]
    fn real_range_preview_keeps_composition_and_exact_duration_and_discards_owned_output() {
        let folder = tempfile::tempdir().unwrap();
        let store = MediaStore::new(folder.path()).unwrap();
        let runtime = runtime();
        let spec = fixture(&store, &runtime);
        let jobs = JobManager::default();
        let started = begin(&store, &runtime, &jobs, &spec).unwrap();
        finish(&jobs, &started.id);
        let asset = result(&store, &runtime, &jobs, &started.id).unwrap();
        assert_eq!(asset.kind, "video");
        assert_eq!(asset.width, 160);
        assert!((asset.duration - 0.6).abs() < 0.1);
        let sample = |x: &str, y: &str| {
            let crop = format!("crop=2:2:{x}:{y},scale=1:1");
            let output = engine::process(&runtime.encoder)
                .args(["-v", "error", "-i"])
                .arg(&asset.native_path)
                .args([
                    "-frames:v",
                    "1",
                    "-vf",
                    &crop,
                    "-f",
                    "rawvideo",
                    "-pix_fmt",
                    "rgb24",
                    "-",
                ])
                .output()
                .unwrap();
            assert!(output.status.success());
            output.stdout
        };
        let green = sample("20", "20");
        assert!(green[1] > 180 && green[0] < 50, "{green:?}");
        let blue = sample("100", "60");
        assert!(blue[2] > 180 && blue[0] < 50, "{blue:?}");
        let path = PathBuf::from(&asset.native_path);
        assert!(path.exists());
        discard(&store, &jobs, &started.id).unwrap();
        assert!(!path.exists());
        assert!(store.root.join("source.mp4").exists());
        discard(&store, &jobs, &started.id).unwrap();
    }
    #[test]
    fn real_audio_preview_is_pcm_with_timeline_gain_and_rejects_unowned_or_invalid_ranges() {
        let folder = tempfile::tempdir().unwrap();
        let store = MediaStore::new(folder.path()).unwrap();
        let runtime = runtime();
        let mut spec = fixture(&store, &runtime);
        spec["audioOnly"] = json!(true);
        spec.as_object_mut().unwrap().remove("textAssets");
        let jobs = JobManager::default();
        let started = begin(&store, &runtime, &jobs, &spec).unwrap();
        finish(&jobs, &started.id);
        let asset = result(&store, &runtime, &jobs, &started.id).unwrap();
        assert_eq!(asset.kind, "audio");
        assert!((asset.duration - 0.6).abs() < 0.03);
        let bytes = engine::process(&runtime.encoder)
            .args(["-v", "error", "-i"])
            .arg(&asset.native_path)
            .args(["-ac", "1", "-f", "f32le", "-"])
            .output()
            .unwrap();
        assert!(bytes.status.success());
        let samples: Vec<f32> = bytes
            .stdout
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
            .collect();
        let rms = (samples.iter().map(|n| (*n as f64).powi(2)).sum::<f64>() / samples.len() as f64)
            .sqrt();
        assert!(rms > 0.02 && rms < 0.055, "audio gain {rms}");
        assert!(result(&store, &runtime, &jobs, "missing").is_err());
        discard(&store, &jobs, &started.id).unwrap();
        spec["end"] = json!(100);
        assert!(begin(&store, &runtime, &jobs, &spec).is_err());
        spec["end"] = json!(1.0);
        assert!(begin(&store, &runtime, &jobs, &spec).is_err());
        spec["end"] = json!(1.8);
        spec["width"] = json!(2000);
        assert!(begin(&store, &runtime, &jobs, &spec).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn preview_cleanup_never_follows_symlink_or_claims_ordinary_job() {
        let folder = tempfile::tempdir().unwrap();
        let store = MediaStore::new(folder.path()).unwrap();
        let runtime = runtime();
        let spec = fixture(&store, &runtime);
        let jobs = JobManager::default();
        let started = begin(&store, &runtime, &jobs, &spec).unwrap();
        let job = finish(&jobs, &started.id);
        let path = PathBuf::from(job.output_path.unwrap());
        fs::remove_file(&path).unwrap();
        let outside = folder.path().join("keep");
        fs::write(&outside, b"preserve").unwrap();
        std::os::unix::fs::symlink(&outside, &path).unwrap();
        assert!(discard(&store, &jobs, &started.id).is_err());
        assert_eq!(fs::read(outside).unwrap(), b"preserve");
        let plan = make_plan(&store, &runtime, &spec).unwrap();
        let ordinary = jobs
            .begin(&runtime, plan, store.root.join("ordinary.mp4"))
            .unwrap();
        finish(&jobs, &ordinary.id);
        assert!(discard(&store, &jobs, &ordinary.id).is_err());
        assert!(store.root.join("ordinary.mp4").exists());
    }
}
