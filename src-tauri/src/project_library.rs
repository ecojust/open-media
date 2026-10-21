//! Independent, durable project libraries. Public source files are never moved.
use crate::engine::{Asset, MediaStore, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::HashSet, fs::{self, File, Metadata}, io::{Read, Write}, path::{Path, PathBuf}, sync::Mutex, time::{SystemTime, UNIX_EPOCH}};

const MANIFEST: &str = "project.json";
const MAX_MANIFEST: u64 = 5 * 1024 * 1024;
const MAX_ASSETS: usize = 1000;
const COPY_BUFFER: usize = 64 * 1024;
static WRITES: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedAsset { pub asset_id: String, pub native_path: String, pub size: u64 }
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedProjectMedia { pub directory: String, pub assets: Vec<PreparedAsset> }
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedManagedProject { pub directory: String, pub saved_at: String }
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedProjectSummary {
    pub id: String, pub title: String, pub width: u64, pub height: u64,
    pub duration: f64, pub updated_at: String, pub asset_count: usize,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest { format: String, version: u8, project: Value, summary: ManagedProjectSummary, saved_at: String }

fn valid_id(id: &str) -> bool { !id.is_empty() && id.len() <= 160 && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_') }
fn check_id(id: &str) -> Result<()> { if valid_id(id) { Ok(()) } else { Err("工程标识无效。".into()) } }
fn child_directory(parent: &Path, name: &str) -> Result<PathBuf> {
    let child = parent.join(name);
    match fs::symlink_metadata(&child) {
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => return Err(format!("工程目录不是安全的普通文件夹：{}", child.display())),
        Ok(_) => {},
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => { fs::create_dir(&child).map_err(|e| format!("无法创建工程目录：{e}"))?; },
        Err(error) => return Err(format!("无法访问工程目录：{error}")),
    }
    let canonical = child.canonicalize().map_err(|e| e.to_string())?;
    if canonical.parent() != Some(parent) { return Err("工程目录发生变化，请重试。".into()); }
    Ok(canonical)
}
fn library_root(store: &MediaStore) -> Result<PathBuf> {
    let root = store.root.canonicalize().map_err(|e| format!("素材库不可用：{e}"))?;
    if root != store.root { return Err("素材库位置发生变化。".into()); }
    let data = root.parent().ok_or("无法确定工程库位置。")?;
    child_directory(data, "projects")
}
fn project_directory(store: &MediaStore, id: &str) -> Result<PathBuf> { check_id(id)?; child_directory(&library_root(store)?, id) }
fn regular_file(path: &Path) -> Result<Metadata> {
    let meta = fs::symlink_metadata(path).map_err(|e| format!("文件不可读取（{}）：{e}", path.display()))?;
    if meta.file_type().is_symlink() || !meta.is_file() { return Err(format!("文件不是普通文件：{}", path.display())); }
    Ok(meta)
}
fn same_source(before: &Metadata, after: &Metadata) -> bool { before.len() == after.len() && before.modified().ok() == after.modified().ok() }
fn owned_file(path: &Path, assets: &Path, size: u64) -> Result<Metadata> {
    let meta = regular_file(path)?;
    let canonical = path.canonicalize().map_err(|e| e.to_string())?;
    if canonical.parent() != Some(assets) || !meta.len().eq(&size) || meta.len() == 0 { return Err(format!("工程素材丢失、已更改或不属于此工程：{}", path.display())); }
    Ok(meta)
}

/// Copy once per source revision, with bounded memory; a failed batch never changes a manifest.
pub fn ensure_project_media(store: &MediaStore, project_id: &str, assets: &[Asset]) -> Result<PreparedProjectMedia> {
    let _guard = WRITES.lock().map_err(|_| "工程库忙碌，请重试。")?;
    if assets.len() > MAX_ASSETS { return Err("工程素材数量超出限制。".into()); }
    let directory = project_directory(store, project_id)?;
    let target = child_directory(&directory, "assets")?;
    let mut ids = HashSet::new();
    let sources: Vec<_> = assets.iter().map(|asset| {
        if !valid_id(&asset.id) || !ids.insert(asset.id.clone()) { return Err("工程素材标识无效或重复。".into()); }
        let input = Path::new(&asset.native_path);
        let before = regular_file(input).map_err(|error| format!("素材“{}”无法收录：{error}。请恢复原文件后重试；原工程未被覆盖。", asset.name))?;
        if before.len() == 0 || (asset.size != 0 && before.len() != asset.size) { return Err(format!("素材“{}”的文件大小已更改，请重新导入；原工程未被覆盖。", asset.name)); }
        let canonical = input.canonicalize().map_err(|e| e.to_string())?;
        Ok((asset, canonical, before))
    }).collect::<Result<_>>()?;
    let mut prepared = Vec::with_capacity(sources.len());
    for (asset, source, before) in sources {
        let destination = if source.parent() == Some(target.as_path()) { source.clone() } else {
            let mut hash = Sha256::new();
            hash.update(source.to_string_lossy().as_bytes()); hash.update(before.len().to_le_bytes());
            if let Ok(modified) = before.modified().and_then(|time| time.duration_since(UNIX_EPOCH).map_err(std::io::Error::other)) { hash.update(modified.as_nanos().to_le_bytes()); }
            let extension = source.extension().and_then(|v| v.to_str()).filter(|s| s.len() <= 12 && s.bytes().all(|c| c.is_ascii_alphanumeric())).unwrap_or("media");
            let destination = target.join(format!("{:x}.{extension}", hash.finalize()));
            if destination.try_exists().map_err(|e| e.to_string())? {
                owned_file(&destination, &target, before.len())?;
            } else {
                let mut input = File::open(&source).map_err(|e| format!("无法打开素材“{}”：{e}", asset.name))?;
                let mut output = tempfile::NamedTempFile::new_in(&target).map_err(|e| e.to_string())?;
                let mut buffer = [0u8; COPY_BUFFER]; let mut copied = 0u64;
                loop {
                    let count = input.read(&mut buffer).map_err(|e| format!("无法读取素材“{}”：{e}", asset.name))?;
                    if count == 0 { break; }
                    output.write_all(&buffer[..count]).map_err(|e| format!("无法保存工程素材“{}”，请检查磁盘空间：{e}", asset.name))?;
                    copied += count as u64;
                }
                if copied != before.len() || !same_source(&before, &input.metadata().map_err(|e| e.to_string())?) || !same_source(&before, &regular_file(&source)?) { return Err(format!("复制期间素材“{}”已更改，请重试；原工程未被覆盖。", asset.name)); }
                output.as_file().sync_all().map_err(|e| e.to_string())?;
                output.persist_noclobber(&destination).map_err(|e| format!("无法完成工程素材复制：{e}"))?;
            }
            destination
        };
        prepared.push(PreparedAsset { asset_id: asset.id.clone(), native_path: destination.to_string_lossy().into_owned(), size: before.len() });
    }
    Ok(PreparedProjectMedia { directory: directory.to_string_lossy().into_owned(), assets: prepared })
}

fn summary(project: &Value, duration: f64) -> Result<ManagedProjectSummary> {
    let field = |name: &str| project.get(name).and_then(Value::as_str).filter(|v| !v.is_empty()).map(str::to_owned).ok_or_else(|| format!("工程字段 {name} 无效。"));
    let id = field("id")?; check_id(&id)?;
    let assets = project.get("assets").and_then(Value::as_array).ok_or("工程素材列表无效。")?;
    if project.get("version").and_then(Value::as_u64) != Some(1) || project.get("tracks").and_then(Value::as_array).is_none() || assets.len() > MAX_ASSETS || !duration.is_finite() || !(0.0..=86400.0).contains(&duration) { return Err("工程内容无效。".into()); }
    let dimension = |name: &str| project.get(name).and_then(Value::as_u64).filter(|v| (1..=32768).contains(v)).ok_or_else(|| format!("工程尺寸 {name} 无效。"));
    Ok(ManagedProjectSummary { id, title: field("title")?, width: dimension("width")?, height: dimension("height")?, duration, updated_at: field("updatedAt")?, asset_count: assets.len() })
}
fn verify_assets(project: &Value, directory: &Path) -> Result<()> {
    let assets_dir = child_directory(directory, "assets")?;
    let mut ids = HashSet::new();
    for asset in project["assets"].as_array().ok_or("工程素材列表无效。")? {
        let id = asset["id"].as_str().ok_or("工程素材缺少标识。")?;
        if !valid_id(id) || !ids.insert(id) { return Err("工程素材标识无效或重复。".into()); }
        let path = asset["nativePath"].as_str().ok_or("素材尚未收录到工程目录。")?;
        let size = asset["size"].as_u64().ok_or("工程素材大小无效。")?;
        owned_file(Path::new(path), &assets_dir, size).map_err(|e| format!("工程素材“{}”不可用：{e}。请恢复该文件后重试。", asset["name"].as_str().unwrap_or(id)))?;
    }
    Ok(())
}
fn utc_timestamp() -> String {
    let elapsed = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let seconds = elapsed.as_secs(); let days = (seconds / 86400) as i64;
    let z = days + 719468; let era = z / 146097; let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut year = yoe + era * 400; let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153; let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 }; year += i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z", seconds / 3600 % 24, seconds / 60 % 60, seconds % 60, elapsed.subsec_millis())
}

/// Persist metadata only. Call ensure_project_media before accepting new assets.
pub fn save_managed_project(store: &MediaStore, project: &Value, duration: f64) -> Result<SavedManagedProject> {
    let _guard = WRITES.lock().map_err(|_| "工程库忙碌，请重试。")?;
    let summary = summary(project, duration)?;
    let directory = project_directory(store, &summary.id)?;
    verify_assets(project, &directory)?;
    let destination = directory.join(MANIFEST);
    if destination.try_exists().map_err(|e| e.to_string())? { regular_file(&destination)?; }
    let saved_at = utc_timestamp(); let mut durable = project.clone();
    for asset in durable["assets"].as_array_mut().ok_or("工程素材列表无效。")? {
        let object = asset.as_object_mut().ok_or("工程素材无效。")?;
        object.insert("url".into(), Value::String(String::new())); object.remove("sourceUrl");
    }
    let manifest = Manifest { format: "open-media-managed-project".into(), version: 1, project: durable, summary, saved_at: saved_at.clone() };
    let bytes = serde_json::to_vec(&manifest).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_MANIFEST { return Err("工程元数据超过 5 MB；原工程未被覆盖。".into()); }
    let mut pending = tempfile::NamedTempFile::new_in(&directory).map_err(|e| e.to_string())?;
    pending.write_all(&bytes).map_err(|e| format!("工程草稿写入失败：{e}"))?;
    pending.as_file().sync_all().map_err(|e| e.to_string())?;
    pending.persist(&destination).map_err(|e| format!("工程草稿保存失败：{e}"))?;
    Ok(SavedManagedProject { directory: directory.to_string_lossy().into_owned(), saved_at })
}
fn read_manifest(directory: &Path, id: &str) -> Result<Manifest> {
    let path = directory.join(MANIFEST); let meta = regular_file(&path)?;
    if meta.len() > MAX_MANIFEST { return Err("工程元数据超过 5 MB，无法打开。".into()); }
    let mut bytes = Vec::new(); File::open(path).map_err(|e| e.to_string())?.take(MAX_MANIFEST + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_MANIFEST { return Err("工程元数据大小已更改。".into()); }
    let mut manifest: Manifest = serde_json::from_slice(&bytes).map_err(|e| format!("工程元数据损坏：{e}"))?;
    if manifest.format != "open-media-managed-project" || manifest.version != 1 || manifest.project["id"].as_str() != Some(id) { return Err("工程元数据与目录不匹配。".into()); }
    manifest.summary = summary(&manifest.project, manifest.summary.duration)?;
    Ok(manifest)
}
pub fn list_managed_projects(store: &MediaStore) -> Result<Vec<ManagedProjectSummary>> {
    let _guard = WRITES.lock().map_err(|_| "工程库忙碌，请重试。")?;
    let root = library_root(store)?; let mut projects = Vec::new();
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_dir() { continue; }
        let id = entry.file_name().to_string_lossy().into_owned(); if !valid_id(&id) { continue; }
        // A corrupt draft must not hide other recoverable projects.
        if let Ok(manifest) = read_manifest(&entry.path(), &id) { projects.push(manifest.summary); }
    }
    projects.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then_with(|| a.id.cmp(&b.id)));
    Ok(projects)
}
pub fn load_managed_project(store: &MediaStore, id: &str) -> Result<Value> {
    let _guard = WRITES.lock().map_err(|_| "工程库忙碌，请重试。")?;
    let directory = project_directory(store, id)?; let manifest = read_manifest(&directory, id)?;
    verify_assets(&manifest.project, &directory)?;
    let mut project = manifest.project;
    project.as_object_mut().ok_or("工程内容无效。")?.insert("localDraftSavedAt".into(), Value::String(manifest.saved_at));
    Ok(project)
}
pub fn remove_managed_project_draft(store: &MediaStore, id: &str) -> Result<()> {
    let _guard = WRITES.lock().map_err(|_| "工程库忙碌，请重试。")?;
    let path = project_directory(store, id)?.join(MANIFEST);
    if !path.try_exists().map_err(|e| e.to_string())? { return Ok(()); }
    regular_file(&path)?; fs::remove_file(path).map_err(|e| format!("无法移除工程草稿：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn fixture() -> (tempfile::TempDir, MediaStore, Asset) {
        let dir = tempfile::tempdir().unwrap(); let store = MediaStore::new(dir.path()).unwrap();
        let source = dir.path().join("public-recording.mp4"); fs::write(&source, b"unchanged source bytes").unwrap();
        let asset = Asset { id: "asset-video".into(), name: "录屏.mp4".into(), kind: "video".into(), url: "asset://source".into(), duration: 600.0, width: 1920, height: 1080, size: 22, mime: "video/mp4".into(), native_path: source.to_string_lossy().into_owned() };
        (dir, store, asset)
    }
    fn project(asset: &PreparedAsset) -> Value { json!({
        "version":1,"id":"project-a","title":"独立工程","width":1920,"height":1080,"fps":30,
        "createdAt":"2026-10-21T00:00:00.000Z","updatedAt":"2026-10-21T12:00:00.000Z",
        "assets":[{"id":asset.asset_id,"name":"录屏.mp4","nativePath":asset.native_path,"size":asset.size,"url":"blob:session-preview","sourceUrl":"blob:source","kind":"video","custom":{"value":42}}],
        "tracks":[{"id":"track-a","clips":[{"id":"clip-a","assetId":asset.asset_id,"text":"保留编辑内容"}]}],
        "mcpMotion":{"enabled":true,"assetIds":[asset.asset_id],"styleId":"style-a"}
    }) }
    #[test]
    fn copies_sources_once_into_independent_project_libraries() {
        let (_dir, store, asset) = fixture();
        let one = ensure_project_media(&store, "project-a", &[asset.clone()]).unwrap();
        let path = Path::new(&one.assets[0].native_path);
        assert_eq!(fs::read(path).unwrap(), fs::read(&asset.native_path).unwrap());
        assert_ne!(path, Path::new(&asset.native_path));
        let original_modified = fs::metadata(path).unwrap().modified().unwrap();
        let repeated = ensure_project_media(&store, "project-a", &[asset.clone()]).unwrap();
        assert_eq!(one.assets[0].native_path, repeated.assets[0].native_path);
        assert_eq!(fs::metadata(path).unwrap().modified().unwrap(), original_modified);
        let other = ensure_project_media(&store, "project-b", &[asset.clone()]).unwrap();
        assert_ne!(one.assets[0].native_path, other.assets[0].native_path);
        fs::write(&asset.native_path, b"different public bytes").unwrap();
        assert_eq!(fs::read(path).unwrap(), b"unchanged source bytes");
        assert_eq!(fs::read(&other.assets[0].native_path).unwrap(), b"unchanged source bytes");
        let mut owned = asset; owned.native_path = one.assets[0].native_path.clone();
        assert_eq!(ensure_project_media(&store, "project-a", &[owned]).unwrap().assets[0].native_path, one.assets[0].native_path);
    }
    #[test]
    fn saves_loads_and_lists_metadata_without_public_sources_or_session_urls() {
        let (_dir, store, asset) = fixture();
        let prepared = ensure_project_media(&store, "project-a", &[asset.clone()]).unwrap();
        let original = project(&prepared.assets[0]);
        let result = save_managed_project(&store, &original, 654.321).unwrap();
        assert!(result.saved_at.ends_with('Z')); assert_eq!(result.saved_at.len(), 24);
        fs::remove_file(&asset.native_path).unwrap();
        let loaded = load_managed_project(&store, "project-a").unwrap();
        assert_eq!(loaded["localDraftSavedAt"], result.saved_at);
        assert_ne!(loaded["localDraftSavedAt"], loaded["updatedAt"]);
        assert_eq!(loaded["tracks"], original["tracks"]); assert_eq!(loaded["mcpMotion"], original["mcpMotion"]);
        assert_eq!(loaded["assets"][0]["custom"], original["assets"][0]["custom"]);
        assert_eq!(loaded["assets"][0]["url"], ""); assert!(loaded["assets"][0].get("sourceUrl").is_none());
        let summaries = list_managed_projects(&store).unwrap();
        assert_eq!(summaries.len(), 1); assert_eq!(summaries[0].duration, 654.321); assert_eq!(summaries[0].asset_count, 1);
        remove_managed_project_draft(&store, "project-a").unwrap();
        assert!(list_managed_projects(&store).unwrap().is_empty());
        assert!(Path::new(&prepared.assets[0].native_path).is_file());
    }
    #[test]
    fn failed_addition_or_save_preserves_previous_manifest_and_sources() {
        let (_dir, store, asset) = fixture();
        let prepared = ensure_project_media(&store, "project-a", &[asset.clone()]).unwrap();
        let original = project(&prepared.assets[0]); save_managed_project(&store, &original, 10.0).unwrap();
        let before = fs::read(Path::new(&prepared.directory).join(MANIFEST)).unwrap();
        let mut missing = asset.clone(); missing.native_path.push_str("-missing");
        assert!(ensure_project_media(&store, "project-a", &[missing]).unwrap_err().contains("原工程未被覆盖"));
        let mut external = original.clone(); external["assets"][0]["nativePath"] = json!(asset.native_path);
        assert!(save_managed_project(&store, &external, 10.0).is_err());
        assert_eq!(fs::read(Path::new(&prepared.directory).join(MANIFEST)).unwrap(), before);
        assert!(Path::new(&asset.native_path).exists());
        fs::remove_file(&prepared.assets[0].native_path).unwrap();
        assert!(load_managed_project(&store, "project-a").unwrap_err().contains("录屏.mp4"));
        assert_eq!(list_managed_projects(&store).unwrap().len(), 1);
    }
    #[test]
    fn empty_projects_and_invalid_ids_are_handled_without_escaping_library() {
        let (_dir, store, _) = fixture();
        let empty = ensure_project_media(&store, "project-empty", &[]).unwrap();
        assert!(Path::new(&empty.directory).join("assets").is_dir());
        for id in ["", "..", "../outside", "a/b", "a\\b", "a.b"] { assert!(ensure_project_media(&store, id, &[]).is_err()); }
    }
    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_library_and_sources() {
        use std::os::unix::fs::symlink;
        let (dir, store, mut asset) = fixture();
        let outside = dir.path().join("outside"); fs::create_dir(&outside).unwrap();
        symlink(&outside, dir.path().join("projects")).unwrap();
        assert!(ensure_project_media(&store, "project-a", &[]).is_err());
        fs::remove_file(dir.path().join("projects")).unwrap();
        let link = dir.path().join("source-link.mp4"); symlink(&asset.native_path, &link).unwrap(); asset.native_path = link.to_string_lossy().into_owned();
        assert!(ensure_project_media(&store, "project-a", &[asset]).is_err());
        assert_eq!(fs::read_dir(outside).unwrap().count(), 0);
    }
}
