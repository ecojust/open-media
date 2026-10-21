use crate::engine::{Asset, MediaStore, Result, Runtime};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::UNIX_EPOCH,
};

const MAX_INDEX_BYTES: u64 = 8 * 1024 * 1024;
const MAX_INDEX_ENTRIES: usize = 10_000;
const MAX_WARNINGS: usize = 100;
const VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "mov", "mkv", "webm", "avi", "m4v", "mpeg", "mpg", "ts", "mts", "m2ts", "flv", "wmv",
    "3gp", "3g2", "ogv", "mxf", "vob", "f4v",
];
const IMAGE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff", "avif", "heic", "heif", "ico",
];
const AUDIO_EXTENSIONS: &[&str] = &[
    "wav", "mp3", "flac", "ogg", "oga", "opus", "m4a", "aac", "aiff", "aif", "wma",
];
const WORKSPACE_CATEGORIES: &[(&str, &str)] = &[
    ("recording", "video"),
    ("screenshot", "image"),
    ("videogen", "video"),
    ("imagegen", "image"),
    ("musicgen", "audio"),
];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredVideo {
    #[serde(flatten)]
    pub asset: Asset,
    /// Modification time in epoch milliseconds; the UI formats it for the local timezone.
    pub added_at: u64,
    #[serde(skip)]
    modified_at: (u64, u32),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredVideos {
    pub directory: String,
    pub import_directory: Option<String>,
    pub assets: Vec<StoredVideo>,
    pub warnings: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredWorkspaceAssets {
    pub directories: HashMap<String, String>,
    pub assets: Vec<StoredVideo>,
    pub warnings: Vec<String>,
}

#[derive(Clone)]
pub struct WorkspaceLibrary {
    libraries: HashMap<String, VideoLibrary>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Fingerprint {
    size: u64,
    modified_seconds: u64,
    modified_nanos: u32,
}
impl Fingerprint {
    fn read(metadata: &fs::Metadata) -> Result<Self> {
        let modified = metadata
            .modified()
            .map_err(|error| error.to_string())?
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "文件修改时间无效。")?;
        Ok(Self {
            size: metadata.len(),
            modified_seconds: modified.as_secs(),
            modified_nanos: modified.subsec_nanos(),
        })
    }
    fn milliseconds(&self) -> u64 {
        self.modified_seconds
            .saturating_mul(1000)
            .saturating_add(u64::from(self.modified_nanos / 1_000_000))
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    fingerprint: Fingerprint,
    asset: Option<Asset>,
    error: Option<String>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Index {
    version: u32,
    runtime: String,
    entries: HashMap<String, Entry>,
}
#[derive(Default)]
struct Cache {
    loaded: bool,
    runtime: String,
    entries: HashMap<String, Entry>,
}

#[derive(Clone)]
pub struct VideoLibrary {
    path: PathBuf,
    cache: Arc<Mutex<Cache>>,
}

pub(crate) fn video_name(name: &str) -> bool {
    media_name(name, "video")
}
fn media_name(name: &str, kind: &str) -> bool {
    if name.starts_with('.')
        || name.len() > 1024
        || Path::new(name).file_name().and_then(|name| name.to_str()) != Some(name)
    {
        return false;
    }
    let extension = Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match kind {
        "video" => VIDEO_EXTENSIONS.contains(&extension.as_str()),
        "image" => IMAGE_EXTENSIONS.contains(&extension.as_str()),
        "audio" => AUDIO_EXTENSIONS.contains(&extension.as_str()),
        _ => false,
    }
}
fn usable_asset(asset: &Asset, kind: &str) -> bool {
    asset.kind == kind
        && asset.duration.is_finite()
        && asset.duration > 0.0
        && (kind == "audio" || (asset.width > 0 && asset.height > 0))
}
fn stable_id(root: &Path, name: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(root.as_os_str().as_encoded_bytes());
    hash.update(b"\0");
    hash.update(name.as_bytes());
    let hash = hash.finalize();
    format!(
        "stored-video-{}",
        hash.iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}
fn runtime_key(runtime: &Runtime) -> String {
    let stamp = fs::metadata(&runtime.probe)
        .ok()
        .and_then(|metadata| Fingerprint::read(&metadata).ok());
    format!(
        "{}|{}|{stamp:?}",
        runtime.probe.to_string_lossy(),
        runtime.version
    )
}
fn usable_entry(name: &str, entry: &Entry) -> bool {
    ["video", "image", "audio"]
        .iter()
        .any(|kind| media_name(name, kind))
        && entry.fingerprint.modified_nanos < 1_000_000_000
        && entry.error.as_ref().is_none_or(|error| error.len() <= 4096)
        && entry.asset.as_ref().is_none_or(|asset| {
            usable_asset(asset, &asset.kind)
                && media_name(name, &asset.kind)
                && asset.size == entry.fingerprint.size
        })
}
fn read_index(path: &Path) -> Result<Option<Index>> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("无法读取视频目录索引：{error}")),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_INDEX_BYTES
    {
        return Err("视频目录索引无效，将重新读取媒体信息。".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|error| error.to_string())?
        .take(MAX_INDEX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_INDEX_BYTES {
        return Err("视频目录索引过大，将重新读取媒体信息。".into());
    }
    let index: Index =
        serde_json::from_slice(&bytes).map_err(|_| "视频目录索引损坏，将重新读取媒体信息。")?;
    if index.version != 1
        || index.entries.len() > MAX_INDEX_ENTRIES
        || index
            .entries
            .iter()
            .any(|(name, entry)| !usable_entry(name, entry))
    {
        return Err("视频目录索引无效，将重新读取媒体信息。".into());
    }
    Ok(Some(index))
}
fn save_index(path: &Path, runtime: &str, entries: HashMap<String, Entry>) -> Result<()> {
    let bytes = serde_json::to_vec(&Index {
        version: 1,
        runtime: runtime.into(),
        entries,
    })
    .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_INDEX_BYTES {
        return Err("视频目录索引超出缓存上限，未保存；目录内容仍可使用。".into());
    }
    let mut staged = tempfile::NamedTempFile::new_in(path.parent().ok_or("视频索引目录无效。")?)
        .map_err(|error| format!("无法更新视频目录索引：{error}"))?;
    staged
        .write_all(&bytes)
        .map_err(|error| error.to_string())?;
    staged
        .as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    staged
        .persist(path)
        .map_err(|error| format!("无法更新视频目录索引：{}", error.error))?;
    Ok(())
}

impl VideoLibrary {
    /// The index path is chosen by the application, never by a renderer request.
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            cache: Arc::new(Mutex::new(Cache::default())),
        }
    }

    pub fn list_stored(
        &self,
        imports: &Self,
        store: &MediaStore,
        runtime: &Runtime,
        include_imported: bool,
    ) -> Result<StoredVideos> {
        let mut result = self.list(&store.recording_store()?, runtime)?;
        if include_imported {
            let imported = imports.list(&store.import_video_store()?, runtime)?;
            result.import_directory = Some(imported.directory);
            result.assets.extend(imported.assets);
            result.warnings.extend(imported.warnings);
        }
        result.assets.sort_by(|left, right| {
            right
                .modified_at
                .cmp(&left.modified_at)
                .then_with(|| left.asset.native_path.cmp(&right.asset.native_path))
        });
        Ok(result)
    }

    pub fn list(&self, store: &MediaStore, runtime: &Runtime) -> Result<StoredVideos> {
        self.list_kind(store, runtime, "video")
    }

    fn list_kind(&self, store: &MediaStore, runtime: &Runtime, kind: &str) -> Result<StoredVideos> {
        let metadata = fs::symlink_metadata(&store.root)
            .map_err(|error| format!("媒体保存目录不可用：{error}"))?;
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || store
                .root
                .canonicalize()
                .map_err(|error| error.to_string())?
                != store.root
        {
            return Err("媒体保存目录已改变，请重新打开应用。".into());
        }
        let mut cache = self.cache.lock().map_err(|_| "视频目录索引状态不可用。")?;
        let mut warnings = Vec::new();
        let mut warning_count = 0;
        let mut warn = |message: String| {
            warning_count += 1;
            if warnings.len() < MAX_WARNINGS {
                warnings.push(message);
            }
        };
        let runtime = (
            format!("{:?}|{}|{kind}", store.root, runtime_key(runtime)),
            runtime,
        );
        if !cache.loaded {
            match read_index(&self.path) {
                Ok(Some(index)) => {
                    cache.runtime = index.runtime;
                    cache.entries = index.entries;
                }
                Ok(None) => {}
                Err(error) => warn(error),
            }
            cache.loaded = true;
        }
        let mut changed = false;
        if cache.runtime != runtime.0 {
            cache.runtime = runtime.0;
            cache.entries.clear();
            changed = true;
        }
        let mut files = Vec::new();
        for item in
            fs::read_dir(&store.root).map_err(|error| format!("无法读取媒体保存目录：{error}"))?
        {
            let item = match item {
                Ok(item) => item,
                Err(error) => {
                    warn(format!("已跳过无法读取的目录项目：{error}"));
                    continue;
                }
            };
            let Some(name) = item.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if !media_name(&name, kind) {
                continue;
            }
            let path = item.path();
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(error) => {
                    warn(format!("已跳过 {name}：{error}"));
                    continue;
                }
            };
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                continue;
            }
            // Restrict even cached entries to an existing direct child of the authorized root.
            let canonical = match path.canonicalize() {
                Ok(path) => path,
                Err(error) => {
                    warn(format!("已跳过 {name}：{error}"));
                    continue;
                }
            };
            if canonical.parent() != Some(store.root.as_path()) {
                continue;
            }
            let fingerprint = match Fingerprint::read(&metadata) {
                Ok(value) => value,
                Err(error) => {
                    warn(format!("已跳过 {name}：{error}"));
                    continue;
                }
            };
            files.push((name, canonical, fingerprint));
        }
        files.sort_by(|left, right| {
            right
                .2
                .modified_seconds
                .cmp(&left.2.modified_seconds)
                .then_with(|| right.2.modified_nanos.cmp(&left.2.modified_nanos))
                .then_with(|| left.0.cmp(&right.0))
        });
        let existing: HashSet<_> = files.iter().map(|(name, _, _)| name.clone()).collect();
        let previous_count = cache.entries.len();
        cache.entries.retain(|name, _| existing.contains(name));
        changed |= previous_count != cache.entries.len();
        let mut assets = Vec::new();
        for (name, path, fingerprint) in &files {
            if cache
                .entries
                .get(name)
                .is_none_or(|entry| entry.fingerprint != *fingerprint)
            {
                let (asset, error) = match store.probe(runtime.1, path, name) {
                    Ok(asset) if usable_asset(&asset, kind) => (Some(asset), None),
                    Ok(_) => (None, None),
                    Err(error) => (None, Some(error)),
                };
                let unchanged = fs::symlink_metadata(path)
                    .ok()
                    .filter(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
                    .and_then(|metadata| Fingerprint::read(&metadata).ok())
                    .is_some_and(|after| after == *fingerprint);
                if !unchanged {
                    cache.entries.remove(name);
                    changed = true;
                    warn(format!(
                        "已跳过 {name}：文件正在写入或已经移除，请稍后刷新。"
                    ));
                    continue;
                }
                cache.entries.insert(
                    name.clone(),
                    Entry {
                        fingerprint: fingerprint.clone(),
                        asset,
                        error,
                    },
                );
                changed = true;
            }
            let entry = &cache.entries[name];
            if let Some(error) = &entry.error {
                warn(format!("已跳过 {name}：{error}"));
            }
            if let Some(mut asset) = entry.asset.clone() {
                if !usable_asset(&asset, kind) {
                    continue;
                }
                asset.id = stable_id(&store.root, name);
                asset.name = crate::media_metadata::original_name(store, path)
                    .unwrap_or_else(|| name.clone());
                asset.native_path = path.to_string_lossy().into();
                asset.url.clear();
                asset.size = fingerprint.size;
                assets.push(StoredVideo {
                    asset,
                    added_at: fingerprint.milliseconds(),
                    modified_at: (fingerprint.modified_seconds, fingerprint.modified_nanos),
                });
            }
        }
        // Prefer recent files when bounding the index. All videos are still returned.
        if cache.entries.len() > MAX_INDEX_ENTRIES {
            let retained: HashSet<_> = files
                .iter()
                .take(MAX_INDEX_ENTRIES)
                .map(|(name, _, _)| name.clone())
                .collect();
            cache.entries.retain(|name, _| retained.contains(name));
            changed = true;
        }
        if changed {
            if let Err(error) = save_index(&self.path, &cache.runtime, cache.entries.clone()) {
                warn(error);
            }
        }
        drop(warn);
        if warning_count > warnings.len() {
            warnings.push(format!(
                "另有 {} 个目录项目未能读取。",
                warning_count - warnings.len()
            ));
        }
        Ok(StoredVideos {
            directory: store.root.to_string_lossy().into(),
            import_directory: None,
            assets,
            warnings,
        })
    }
}

impl WorkspaceLibrary {
    pub fn new(app_data: &Path) -> Self {
        let libraries = WORKSPACE_CATEGORIES
            .iter()
            .map(|(category, _)| *category)
            .map(|category| {
                (
                    category.to_owned(),
                    VideoLibrary::new(app_data.join(format!("workspace-{category}-index.json"))),
                )
            })
            .collect();
        Self { libraries }
    }

    pub fn list(
        &self,
        store: &MediaStore,
        runtime: &Runtime,
        categories: &[String],
    ) -> Result<StoredWorkspaceAssets> {
        if categories.is_empty()
            || categories.len() > WORKSPACE_CATEGORIES.len()
            || categories.iter().any(|category| {
                !WORKSPACE_CATEGORIES
                    .iter()
                    .any(|(name, _)| category == name)
            })
        {
            return Err("请选择有效的素材分类。".into());
        }
        let mut result = StoredWorkspaceAssets {
            directories: HashMap::new(),
            assets: Vec::new(),
            warnings: Vec::new(),
        };
        for category in categories {
            if result.directories.contains_key(category) {
                continue;
            }
            let category_store = store.workspace_store(category)?;
            let kind = WORKSPACE_CATEGORIES
                .iter()
                .find(|(name, _)| category == name)
                .unwrap()
                .1;
            result.directories.insert(
                category.clone(),
                category_store.root.to_string_lossy().into(),
            );
            let listed = self.libraries[category].list_kind(&category_store, runtime, kind)?;
            result.assets.extend(listed.assets);
            result.warnings.extend(listed.warnings);
        }
        result.assets.sort_by(|left, right| {
            right
                .modified_at
                .cmp(&left.modified_at)
                .then_with(|| left.asset.native_path.cmp(&right.asset.native_path))
        });
        result.warnings.truncate(MAX_WARNINGS);
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::process;
    use std::time::Duration;

    fn runtime() -> Runtime {
        Runtime::discover(None, None)
            .expect("Media runtime required for video library integration checks")
    }
    fn video(directory: &Path, runtime: &Runtime) -> PathBuf {
        let path = directory.join("source.mp4");
        let result = process(&runtime.encoder)
            .args([
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=blue:s=160x90:r=10:d=0.3",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(&path)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        path
    }
    fn modified(path: &Path, seconds: u64) {
        fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_secs(seconds)))
            .unwrap();
    }

    #[test]
    fn workspace_lists_only_new_categories_without_moving_or_copying_old_files() {
        let directory = tempfile::tempdir().unwrap();
        let runtime = runtime();
        let source = video(directory.path(), &runtime);
        let picture = directory.path().join("picture.png");
        let extracted = process(&runtime.encoder)
            .args(["-v", "error", "-i"])
            .arg(&source)
            .args(["-frames:v", "1"])
            .arg(&picture)
            .output()
            .unwrap();
        assert!(
            extracted.status.success(),
            "{}",
            String::from_utf8_lossy(&extracted.stderr)
        );
        let music = directory.path().join("music.wav");
        let generated = process(&runtime.encoder)
            .args([
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=660:duration=0.2",
            ])
            .arg(&music)
            .output()
            .unwrap();
        assert!(generated.status.success());
        let store = MediaStore::new(directory.path()).unwrap();
        let mut expected = HashSet::new();
        for (index, (category, kind)) in WORKSPACE_CATEGORIES.iter().enumerate() {
            let target = store.workspace_store(category).unwrap();
            let (input, label) = match *kind {
                "image" => (&picture, "图片.png"),
                "audio" => (&music, "歌曲.wav"),
                _ => (&source, "视频.mp4"),
            };
            let asset = target.import(&runtime, input, Some(label)).unwrap();
            modified(Path::new(&asset.native_path), 1_700_000_000 + index as u64);
            expected.insert(asset.native_path);
            // Wrong types and nested files are never loaded into a category's list.
            let other = if *kind == "video" { &picture } else { &source };
            fs::copy(other, target.root.join(other.file_name().unwrap())).unwrap();
            fs::create_dir(target.root.join("nested")).unwrap();
            fs::copy(
                input,
                target.root.join("nested").join(input.file_name().unwrap()),
            )
            .unwrap();
        }
        let legacy_root = directory.path().join("recordings");
        fs::create_dir(&legacy_root).unwrap();
        let legacy = legacy_root.join("旧录屏.mp4");
        fs::copy(&source, &legacy).unwrap();
        let legacy = legacy.canonicalize().unwrap();
        modified(&legacy, 1_700_000_100);
        let ignored = store
            .import(&runtime, &source, Some("旧通用素材.mp4"))
            .unwrap();
        let imported = store
            .import_video_store()
            .unwrap()
            .import(&runtime, &source, Some("导入视频.mp4"))
            .unwrap();
        let library = WorkspaceLibrary::new(directory.path());
        let categories: Vec<_> = WORKSPACE_CATEGORIES
            .iter()
            .map(|(name, _)| name.to_string())
            .collect();
        let listed = library.list(&store, &runtime, &categories).unwrap();
        assert!(listed.warnings.is_empty(), "{:?}", listed.warnings);
        assert_eq!(listed.assets.len(), 5);
        assert_eq!(listed.assets[0].asset.kind, "audio");
        assert_eq!(listed.assets[0].added_at, 1_700_000_004_000);
        assert!(!listed.assets.iter().any(|item| item.asset.native_path == legacy.to_string_lossy()));
        assert_eq!(
            listed.directories["recording"],
            directory.path().join("recording").canonicalize().unwrap().to_string_lossy()
        );
        assert_eq!(
            listed.directories["imagegen"],
            directory.path().join("imagegen").canonicalize().unwrap().to_string_lossy()
        );
        assert_eq!(
            listed
                .assets
                .iter()
                .map(|asset| asset.asset.native_path.clone())
                .collect::<HashSet<_>>(),
            expected
        );
        assert!(!expected.contains(&ignored.native_path));
        assert!(!expected.contains(&imported.native_path));
        for asset in &listed.assets {
            assert!(Path::new(&asset.asset.native_path).is_file());
            assert!(store
                .authorized_path(&serde_json::to_value(&asset.asset).unwrap())
                .is_ok());
        }
        let videos = library
            .list(&store, &runtime, &["recording".into(), "videogen".into()])
            .unwrap();
        assert_eq!(videos.assets.len(), 2);
        assert!(videos
            .assets
            .iter()
            .all(|asset| asset.asset.kind == "video"));
        let screenshots = library
            .list(&store, &runtime, &["screenshot".into()])
            .unwrap();
        assert_eq!(screenshots.assets.len(), 1);
        assert_eq!(screenshots.assets[0].asset.kind, "image");
        let reopened = WorkspaceLibrary::new(directory.path())
            .list(&store, &runtime, &categories)
            .unwrap();
        assert_eq!(
            serde_json::to_value(&listed).unwrap(),
            serde_json::to_value(&reopened).unwrap()
        );
        assert_eq!(fs::read(&legacy).unwrap(), fs::read(&source).unwrap());
        assert!(library
            .list(&store, &runtime, &["../media".into()])
            .is_err());
        assert!(library.list(&store, &runtime, &[]).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn workspace_library_ignores_external_links_and_unrelated_legacy_folder() {
        let directory = tempfile::tempdir().unwrap();
        let runtime = runtime();
        let source = video(directory.path(), &runtime);
        let store = MediaStore::new(directory.path()).unwrap();
        let current = store
            .recording_store()
            .unwrap()
            .import(&runtime, &source, Some("当前录屏.mp4"))
            .unwrap();
        std::os::unix::fs::symlink(directory.path(), directory.path().join("recordings")).unwrap();
        std::os::unix::fs::symlink(
            &source,
            store.recording_store().unwrap().root.join("link.mp4"),
        )
        .unwrap();
        let listed = WorkspaceLibrary::new(directory.path())
            .list(&store, &runtime, &["recording".into()])
            .unwrap();
        assert_eq!(listed.assets.len(), 1);
        assert_eq!(listed.assets[0].asset.native_path, current.native_path);
        assert!(listed.warnings.is_empty());
    }

    #[test]
    fn directory_lists_only_direct_videos_without_copying_and_keeps_names_and_order() {
        let directory = tempfile::tempdir().unwrap();
        let runtime = runtime();
        let source = video(directory.path(), &runtime);
        let store = MediaStore::new(directory.path())
            .unwrap()
            .recording_store()
            .unwrap();
        let imports = MediaStore::new(directory.path()).unwrap();
        let imported = imports
            .import(&runtime, &source, Some("剪辑导入.mp4"))
            .unwrap();
        let old = store
            .import(&runtime, &source, Some("早些时候的录屏.mp4"))
            .unwrap();
        let recent = store
            .import(&runtime, &source, Some("最新的录屏.mp4"))
            .unwrap();
        modified(Path::new(&old.native_path), 1_700_000_000);
        modified(Path::new(&recent.native_path), 1_700_000_020);
        fs::create_dir(store.root.join("preview")).unwrap();
        fs::copy(&source, store.root.join("preview/compatible.mp4")).unwrap();
        fs::copy(&source, store.root.join(".temporary.mp4")).unwrap();
        fs::create_dir(store.root.join("directory.mp4")).unwrap();
        fs::write(store.root.join("image.png"), b"not a candidate").unwrap();
        fs::write(store.root.join("broken.mp4"), b"not a video").unwrap();
        let audio = process(&runtime.encoder)
            .args([
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=0.1",
                "-c:a",
                "aac",
            ])
            .arg(store.root.join("audio-only.mp4"))
            .output()
            .unwrap();
        assert!(audio.status.success());
        let count = fs::read_dir(&store.root).unwrap().count();
        let library = VideoLibrary::new(directory.path().join("index.json"));
        let result = library.list(&store, &runtime).unwrap();
        assert_eq!(result.directory, store.root.to_string_lossy());
        assert_eq!(result.assets.len(), 2);
        assert!(result
            .assets
            .iter()
            .all(|entry| entry.asset.native_path != imported.native_path));
        assert!(
            Path::new(&imported.native_path).is_file(),
            "Listing must preserve prior media assets"
        );
        assert_eq!(result.assets[0].asset.name, "最新的录屏.mp4");
        assert_eq!(result.assets[0].added_at, 1_700_000_020_000);
        assert_eq!(result.assets[0].asset.native_path, recent.native_path);
        assert_eq!(result.assets[1].asset.native_path, old.native_path);
        assert!(result.assets.iter().all(|entry| entry.asset.url.is_empty()));
        assert_eq!(result.warnings.len(), 1);
        assert!(result.warnings[0].contains("broken.mp4"));
        assert_eq!(
            fs::read_dir(&store.root).unwrap().count(),
            count,
            "Listing must not import or duplicate videos"
        );
        let again = library.list(&store, &runtime).unwrap();
        assert_eq!(result.assets[0].asset.id, again.assets[0].asset.id);
        assert_eq!(result.assets[1].asset.id, again.assets[1].asset.id);
        fs::remove_file(&recent.native_path).unwrap();
        let after_delete = library.list(&store, &runtime).unwrap();
        assert_eq!(after_delete.assets.len(), 1);
        let index = read_index(&directory.path().join("index.json"))
            .unwrap()
            .unwrap();
        assert!(!index.entries.contains_key(
            Path::new(&recent.native_path)
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
        ));
    }

    #[test]
    fn damaged_indexes_rebuild_and_cached_paths_cannot_escape_the_library() {
        let directory = tempfile::tempdir().unwrap();
        let runtime = runtime();
        let source = video(directory.path(), &runtime);
        let store = MediaStore::new(directory.path())
            .unwrap()
            .recording_store()
            .unwrap();
        let destination = store.root.join("legacy.mp4");
        fs::copy(source, &destination).unwrap();
        let index_path = directory.path().join("index.json");
        fs::write(&index_path, b"damaged index").unwrap();
        let first = VideoLibrary::new(index_path.clone())
            .list(&store, &runtime)
            .unwrap();
        assert_eq!(first.assets.len(), 1);
        assert_eq!(first.assets[0].asset.name, "legacy.mp4");
        assert!(first
            .warnings
            .iter()
            .any(|warning| warning.contains("索引损坏")));
        let mut index = read_index(&index_path).unwrap().unwrap();
        let entry = index
            .entries
            .get_mut("legacy.mp4")
            .unwrap()
            .asset
            .as_mut()
            .unwrap();
        entry.native_path = directory
            .path()
            .join("outside.mp4")
            .to_string_lossy()
            .into();
        entry.url = "https://untrusted.example/media".into();
        entry.id = "untrusted-id".into();
        fs::write(&index_path, serde_json::to_vec(&index).unwrap()).unwrap();
        let again = VideoLibrary::new(index_path)
            .list(&store, &runtime)
            .unwrap();
        assert_eq!(
            again.assets[0].asset.native_path,
            destination.to_string_lossy()
        );
        assert!(again.assets[0].asset.url.is_empty());
        assert_eq!(again.assets[0].asset.id, first.assets[0].asset.id);
    }

    #[test]
    fn combined_library_is_opt_in_isolated_and_sorted_with_distinct_ids_and_indexes() {
        let directory = tempfile::tempdir().unwrap();
        let runtime = runtime();
        let source = video(directory.path(), &runtime);
        let media = MediaStore::new(directory.path()).unwrap();
        let recordings = media.recording_store().unwrap();
        let recording = recordings.root.join("shared.mp4");
        fs::copy(&source, &recording).unwrap();
        let old_media = media.root.join("built-in.mp4");
        fs::copy(&source, &old_media).unwrap();
        let recording_index = directory.path().join("recordings-index.json");
        let import_index = directory.path().join("imports-index.json");
        let library = VideoLibrary::new(recording_index.clone());
        let import_library = VideoLibrary::new(import_index.clone());

        let default = library
            .list_stored(&import_library, &media, &runtime, false)
            .unwrap();
        assert_eq!(default.assets.len(), 1);
        assert_eq!(default.directory, recordings.root.to_string_lossy());
        assert!(default.import_directory.is_none());
        assert!(!media.import_video_root().unwrap().exists());
        assert!(!import_index.exists());

        let imports = media.import_video_store().unwrap();
        let imported = imports.root.join("shared.mp4");
        fs::copy(&source, &imported).unwrap();
        fs::create_dir(imports.root.join("nested")).unwrap();
        fs::copy(&source, imports.root.join("nested/hidden.mp4")).unwrap();
        // Millisecond display timestamps can match while filesystem ordering differs.
        for (path, nanos) in [(&recording, 100), (&imported, 900)] {
            fs::File::options()
                .write(true)
                .open(path)
                .unwrap()
                .set_times(
                    fs::FileTimes::new()
                        .set_modified(UNIX_EPOCH + Duration::new(1_700_000_000, nanos)),
                )
                .unwrap();
        }
        let combined = library
            .list_stored(&import_library, &media, &runtime, true)
            .unwrap();
        assert_eq!(combined.directory, recordings.root.to_string_lossy());
        assert_eq!(combined.import_directory.as_deref(), imports.root.to_str());
        assert_eq!(combined.assets.len(), 2);
        assert_eq!(
            combined.assets[0].asset.native_path,
            imported.to_string_lossy()
        );
        assert_eq!(
            combined.assets[1].asset.native_path,
            recording.to_string_lossy()
        );
        assert_eq!(combined.assets[0].added_at, combined.assets[1].added_at);
        assert_ne!(combined.assets[0].asset.id, combined.assets[1].asset.id);
        assert_eq!(combined.assets[1].asset.id, default.assets[0].asset.id);
        for index in [&recording_index, &import_index] {
            let index = read_index(index).unwrap().unwrap();
            assert_eq!(index.entries.len(), 1);
            assert!(index.entries.contains_key("shared.mp4"));
        }
        let serialized = serde_json::to_value(&combined).unwrap();
        assert_eq!(
            serialized["importDirectory"],
            imports.root.to_string_lossy().as_ref()
        );
        assert!(serialized["assets"][0].get("modifiedAt").is_none());
        let restarted = VideoLibrary::new(recording_index)
            .list_stored(&VideoLibrary::new(import_index), &media, &runtime, true)
            .unwrap();
        assert_eq!(restarted.assets[0].asset.id, combined.assets[0].asset.id);
        fs::remove_file(&imported).unwrap();
        let after_delete = library
            .list_stored(&import_library, &media, &runtime, true)
            .unwrap();
        assert_eq!(after_delete.assets.len(), 1);
        assert_eq!(after_delete.assets[0].asset.id, default.assets[0].asset.id);
        assert!(old_media.is_file(), "Listing must preserve built-in media");
        assert!(source.is_file(), "Listing must preserve external originals");
    }

    #[cfg(unix)]
    #[test]
    fn unchanged_videos_and_bad_files_are_not_reprobed_even_after_restart() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let mut runtime = runtime();
        let source = video(directory.path(), &runtime);
        let store = MediaStore::new(directory.path())
            .unwrap()
            .recording_store()
            .unwrap();
        let destination = store.root.join("legacy.mp4");
        fs::copy(source, &destination).unwrap();
        fs::write(store.root.join("broken.mp4"), b"invalid").unwrap();
        let counter = directory.path().join("probe-count.txt");
        let script = directory.path().join("count-probes.sh");
        let quote = |value: &str| format!("'{}'", value.replace('\'', "'\"'\"'"));
        fs::write(
            &script,
            format!(
                "#!/bin/sh\nprintf 'probe\\n' >> {}\nexec {} \"$@\"\n",
                quote(&counter.to_string_lossy()),
                quote(&runtime.probe.to_string_lossy())
            ),
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        runtime.probe = script;
        let count = || fs::read_to_string(&counter).unwrap().lines().count();
        let index = directory.path().join("index.json");
        let library = VideoLibrary::new(index.clone());
        let first = library.list(&store, &runtime).unwrap();
        assert_eq!(first.assets.len(), 1);
        assert_eq!(count(), 2);
        library.list(&store, &runtime).unwrap();
        assert_eq!(count(), 2);
        let restored = VideoLibrary::new(index);
        assert_eq!(
            restored.list(&store, &runtime).unwrap().assets[0].asset.id,
            first.assets[0].asset.id
        );
        assert_eq!(
            count(),
            2,
            "Restart should reuse the persistent metadata index"
        );
        modified(&destination, 1_700_000_000);
        restored.list(&store, &runtime).unwrap();
        assert_eq!(count(), 3, "Only the changed video should be probed again");
        let other_directory = tempfile::tempdir().unwrap();
        let other_store = MediaStore::new(other_directory.path())
            .unwrap()
            .recording_store()
            .unwrap();
        let other_video = other_store.root.join("legacy.mp4");
        fs::copy(&destination, &other_video).unwrap();
        modified(&other_video, 1_700_000_000);
        assert_eq!(
            restored.list(&other_store, &runtime).unwrap().assets.len(),
            1
        );
        assert_eq!(
            count(),
            4,
            "An identical file fingerprint in a different root must be probed"
        );
    }

    #[cfg(unix)]
    #[test]
    fn outside_symlink_files_and_replaced_library_roots_are_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let runtime = runtime();
        let source = video(directory.path(), &runtime);
        let store = MediaStore::new(directory.path())
            .unwrap()
            .recording_store()
            .unwrap();
        std::os::unix::fs::symlink(source, store.root.join("outside.mp4")).unwrap();
        let library = VideoLibrary::new(directory.path().join("index.json"));
        assert!(library.list(&store, &runtime).unwrap().assets.is_empty());
        fs::remove_file(store.root.join("outside.mp4")).unwrap();
        fs::remove_dir(&store.root).unwrap();
        std::os::unix::fs::symlink(directory.path(), &store.root).unwrap();
        assert!(library.list(&store, &runtime).is_err());
    }
}
