//! Owned full-quality timeline renders become ordinary project video assets.
use crate::engine::{self, Asset, JobManager, MediaJob, MediaStore, Result, Runtime};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

#[derive(Clone)]
struct Entry {
    directory: PathBuf,
    job_id: Option<String>,
    starting: bool,
    accepted: bool,
    discarded: bool,
    checked_asset: Option<Asset>,
}

#[derive(Clone, Default)]
pub struct MotionClipManager {
    entries: Arc<Mutex<HashMap<String, Entry>>>,
}

fn checked_directory(path: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_dir()
        || meta.file_type().is_symlink()
        || path.canonicalize().map_err(|e| e.to_string())? != path
    {
        return Err("效果片段保存目录已改变。".into());
    }
    Ok(())
}

fn owned_directory(store: &MediaStore, scope: &str, entry: &Entry) -> Result<PathBuf> {
    checked_directory(&store.root)?;
    let expected = store.root.join(format!("motion-clip-{scope}"));
    if scope.len() != 32
        || !scope.bytes().all(|c| c.is_ascii_hexdigit())
        || expected != entry.directory
    {
        return Err("效果片段目录不属于当前任务。".into());
    }
    checked_directory(&expected)?;
    Ok(expected)
}

fn owned_output(store: &MediaStore, scope: &str, entry: &Entry, job: &MediaJob) -> Result<PathBuf> {
    let path = owned_directory(store, scope, entry)?.join("result.mp4");
    if entry.job_id.as_deref() != Some(job.id.as_str())
        || job.name != "result.mp4"
        || job
            .output_path
            .as_ref()
            .is_some_and(|p| PathBuf::from(p) != path)
    {
        return Err("效果片段输出不属于当前任务。".into());
    }
    let meta = fs::symlink_metadata(&path).map_err(|e| format!("效果片段文件不可用：{e}"))?;
    if !meta.is_file()
        || meta.file_type().is_symlink()
        || meta.len() == 0
        || path.canonicalize().map_err(|e| e.to_string())? != path
    {
        return Err("效果片段输出文件无效。".into());
    }
    Ok(path)
}

fn render_spec(spec: &Value) -> Result<Value> {
    let object = spec.as_object().ok_or("效果片段请求无效。")?;
    if object
        .keys()
        .any(|key| !["scopeId", "project", "textAssets", "config"].contains(&key.as_str()))
    {
        return Err("效果片段请求含不支持的参数。".into());
    }
    let project = spec
        .get("project")
        .filter(|v| v.is_object())
        .ok_or("缺少效果片段工程。")?;
    let config = spec
        .get("config")
        .filter(|v| v.is_object())
        .ok_or("缺少效果片段编码设置。")?;
    if config["format"] != "mp4" || !matches!(config["quality"].as_str(), Some("balanced" | "high"))
    {
        return Err("效果片段需使用标准或高质量 MP4 编码。".into());
    }
    for key in ["width", "height"] {
        let source = project[key]
            .as_u64()
            .filter(|n| (16..=7680).contains(n))
            .ok_or("工程画面尺寸无效。")?;
        let target = config[key].as_u64().ok_or("效果片段画面尺寸无效。")?;
        // The encoder requires even dimensions. No downscaling is applied.
        if target != (source / 2) * 2 {
            return Err("效果片段必须沿用当前工程画面尺寸。".into());
        }
    }
    let fps = project["fps"]
        .as_f64()
        .filter(|v| v.is_finite() && *v >= 1.0 && *v <= 120.0)
        .ok_or("工程帧率无效。")?;
    if config["fps"].as_f64() != Some(fps) {
        return Err("效果片段必须沿用当前工程帧率。".into());
    }
    Ok(
        json!({ "kind": "timeline", "project": project, "config": config,
        "textAssets": spec.get("textAssets").cloned().unwrap_or_else(|| json!({})) }),
    )
}

impl MotionClipManager {
    pub fn create_scope(&self, store: &MediaStore) -> Result<String> {
        checked_directory(&store.root)?;
        let mut entries = self.entries.lock().map_err(|_| "效果片段任务不可用。")?;
        if entries
            .values()
            .filter(|entry| !entry.accepted && !entry.discarded)
            .count()
            >= 8
        {
            return Err("请先完成或取消现有的效果片段任务。".into());
        }
        let id = engine::new_id();
        let directory = store.root.join(format!("motion-clip-{id}"));
        fs::create_dir(&directory).map_err(|e| format!("无法创建效果片段目录：{e}"))?;
        if let Err(error) = fs::create_dir(directory.join("inputs")) {
            let _ = fs::remove_dir(&directory);
            return Err(format!("无法创建效果片段素材目录：{error}"));
        }
        entries.insert(
            id.clone(),
            Entry {
                directory,
                job_id: None,
                starting: false,
                accepted: false,
                discarded: false,
                checked_asset: None,
            },
        );
        Ok(id)
    }

    /// Only bytes explicitly materialized for this render are stored in its scope.
    pub fn import_asset(
        &self,
        store: &MediaStore,
        runtime: &Runtime,
        scope: &str,
        bytes: &[u8],
        name: &str,
    ) -> Result<Asset> {
        let entries = self.entries.lock().map_err(|_| "效果片段任务不可用。")?;
        let entry = entries.get(scope).ok_or("效果片段准备任务不存在。")?;
        if entry.starting || entry.job_id.is_some() || entry.accepted || entry.discarded {
            return Err("效果片段素材准备已经结束。".into());
        }
        let root = owned_directory(store, scope, entry)?.join("inputs");
        checked_directory(&root)?;
        MediaStore { root }.import_bytes(runtime, bytes, name)
    }

    pub fn begin(
        &self,
        store: &MediaStore,
        runtime: &Runtime,
        jobs: &JobManager,
        spec: &Value,
    ) -> Result<MediaJob> {
        let spec_for_engine = render_spec(spec)?;
        let created = spec.get("scopeId").is_none();
        let scope = match spec.get("scopeId") {
            Some(value) => value.as_str().ok_or("效果片段准备任务无效。")?.to_owned(),
            None => self.create_scope(store)?,
        };
        let output = {
            let mut entries = self.entries.lock().map_err(|_| "效果片段任务不可用。")?;
            let entry = entries.get_mut(&scope).ok_or("效果片段准备任务不存在。")?;
            if entry.starting || entry.job_id.is_some() || entry.accepted || entry.discarded {
                return Err("效果片段任务已经开始或已取消。".into());
            }
            let output = owned_directory(store, &scope, entry)?.join("result.mp4");
            entry.starting = true;
            output
        };
        let launched = (|| {
            let plan = engine::build_plan(store, runtime, &spec_for_engine)?;
            if plan.duration <= 0.0 || plan.duration > 16.0 * 12.0 + 0.01 {
                return Err("效果片段总时长需大于零且最多 192 秒。".into());
            }
            let entries = self.entries.lock().map_err(|_| "效果片段任务不可用。")?;
            if entries.get(&scope).is_none_or(|entry| entry.discarded) {
                return Err("效果片段任务已取消。".into());
            }
            jobs.begin_with_overwrite(runtime, plan, output, false)
        })();
        {
            let mut entries = self.entries.lock().map_err(|_| "效果片段任务不可用。")?;
            if let Some(entry) = entries.get_mut(&scope) {
                entry.starting = false;
                if let Ok(job) = &launched {
                    entry.job_id = Some(job.id.clone());
                    if entry.discarded {
                        let _ = jobs.cancel(&job.id);
                    }
                }
            }
        }
        if launched.is_err() && created {
            let _ = self.discard(store, jobs, &scope);
        }
        launched
    }

    fn locate(entries: &HashMap<String, Entry>, id: &str) -> Result<String> {
        if entries.contains_key(id) {
            return Ok(id.to_owned());
        }
        entries
            .iter()
            .find(|(_, entry)| entry.job_id.as_deref() == Some(id))
            .map(|(scope, _)| scope.clone())
            .ok_or_else(|| "该任务不是受管效果片段。".into())
    }

    pub fn result(
        &self,
        store: &MediaStore,
        runtime: &Runtime,
        jobs: &JobManager,
        id: &str,
    ) -> Result<Asset> {
        let mut entries = self.entries.lock().map_err(|_| "效果片段任务不可用。")?;
        let scope = Self::locate(&entries, id)?;
        let entry = entries.get_mut(&scope).unwrap();
        if entry.discarded {
            return Err("效果片段任务已取消。".into());
        }
        let job = entry
            .job_id
            .as_deref()
            .and_then(|id| jobs.get(id))
            .ok_or("效果片段尚未开始编码。")?;
        if job.state != "completed" {
            return Err(job.error.unwrap_or_else(|| "效果片段尚未完成。".into()));
        }
        let path = owned_output(store, &scope, entry, &job)?;
        if let Some(asset) = &entry.checked_asset {
            return Ok(asset.clone());
        }
        let mut asset = store.probe(runtime, &path, "效果片段.mp4")?;
        if asset.kind != "video"
            || asset.width < 16
            || asset.height < 16
            || !asset.duration.is_finite()
            || asset.duration <= 0.0
            || asset.size == 0
        {
            return Err("效果片段没有生成有效的视频。".into());
        }
        asset.id = format!("motion-clip-{scope}");
        // Encoding has ended, so disposable raster layers are no longer needed.
        let inputs = entry.directory.join("inputs");
        if inputs.exists() {
            checked_directory(&inputs)?;
            fs::remove_dir_all(&inputs).map_err(|e| format!("无法清理效果片段临时素材：{e}"))?;
        }
        entry.checked_asset = Some(asset.clone());
        Ok(asset)
    }

    pub fn accept(&self, store: &MediaStore, jobs: &JobManager, id: &str) -> Result<()> {
        let mut entries = self.entries.lock().map_err(|_| "效果片段任务不可用。")?;
        let scope = Self::locate(&entries, id)?;
        let entry = entries.get_mut(&scope).unwrap();
        if entry.discarded || entry.checked_asset.is_none() {
            return Err("效果片段尚未校验或已取消，不能添加到工程。".into());
        }
        let job = entry
            .job_id
            .as_deref()
            .and_then(|id| jobs.get(id))
            .ok_or("效果片段任务不存在。")?;
        if job.state != "completed" {
            return Err("效果片段尚未完成，不能添加到工程。".into());
        }
        owned_output(store, &scope, entry, &job)?;
        entry.accepted = true;
        Ok(())
    }

    pub fn discard(&self, store: &MediaStore, jobs: &JobManager, id: &str) -> Result<()> {
        let scope = {
            let mut entries = self.entries.lock().map_err(|_| "效果片段任务不可用。")?;
            let scope = Self::locate(&entries, id)?;
            let entry = entries.get_mut(&scope).unwrap();
            if entry.accepted {
                return Ok(());
            }
            if entry.discarded && !entry.directory.exists() {
                return Ok(());
            }
            owned_directory(store, &scope, entry)?;
            entry.discarded = true;
            if let Some(id) = &entry.job_id {
                jobs.cancel(id)?;
            }
            scope
        };
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let entries = self.entries.lock().map_err(|_| "效果片段任务不可用。")?;
            let entry = entries.get(&scope).ok_or("效果片段任务不存在。")?;
            let running = entry.starting
                || entry
                    .job_id
                    .as_deref()
                    .and_then(|id| jobs.get(id))
                    .is_some_and(|job| job.state == "running");
            if !running {
                if entry.directory.exists() {
                    owned_directory(store, &scope, entry)?;
                    fs::remove_dir_all(&entry.directory)
                        .map_err(|e| format!("无法清理效果片段：{e}"))?;
                }
                return Ok(());
            }
            drop(entries);
            if Instant::now() >= deadline {
                return Err("效果片段正在取消，请稍后清理。".into());
            }
            thread::sleep(Duration::from_millis(30));
        }
    }
}

#[cfg(test)]
#[path = "motion_clip_tests.rs"]
mod tests;
