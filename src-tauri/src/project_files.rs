use crate::engine::Result;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs::File,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

const MAX_PROJECT_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_REGISTRY_BYTES: u64 = 4 * 1024 * 1024;
const MAX_REGISTERED_TARGETS: usize = 1024;
const MAX_TARGET_PATH_BYTES: usize = 32768;
const INVALID_TARGET: &str = "项目保存位置已失效，请使用另存为重新选择位置。";

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct TargetRegistry {
    version: u32,
    targets: Vec<RegisteredTarget>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RegisteredTarget {
    token: String,
    path: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ProjectTarget {
    pub name: String,
    pub path: String,
    pub token: String,
}

#[derive(Debug, Serialize)]
pub struct ProjectFile {
    pub name: String,
    pub bytes: Vec<u8>,
    pub path: String,
    pub token: String,
}

#[derive(Clone, Default)]
pub struct ProjectFiles {
    targets: Arc<Mutex<HashMap<String, PathBuf>>>,
    registry_path: Option<Arc<PathBuf>>,
}

pub fn require_main_window(label: &str) -> Result<()> {
    if label == "main" {
        Ok(())
    } else {
        Err("只有主窗口可以打开或保存项目。".into())
    }
}

pub fn validate_project_size(size: u64) -> Result<()> {
    if size > MAX_PROJECT_BYTES {
        Err("项目文件超过 1 GB 上限。".into())
    } else {
        Ok(())
    }
}

impl ProjectFiles {
    /// The registry path must come from the application's private data directory.
    pub fn persistent(registry_path: PathBuf) -> Result<Self> {
        validate_target_path(&registry_path)?;
        let targets = read_registry(&registry_path)?;
        Ok(Self {
            targets: Arc::new(Mutex::new(targets)),
            registry_path: Some(Arc::new(registry_path)),
        })
    }

    pub fn save_selected(&self, path: PathBuf, bytes: &[u8]) -> Result<ProjectTarget> {
        validate_project_size(bytes.len() as u64)?;
        validate_target_path(&path)?;
        let mut targets = self.targets.lock().map_err(|_| "项目保存状态不可用。")?;
        let token = selected_token(&targets, &path)?;
        write_atomic(&path, bytes)?;
        self.register(&mut targets, token.clone(), path.clone())?;
        Ok(target(&path, token))
    }

    pub fn save_registered(&self, token: &str, bytes: &[u8]) -> Result<ProjectTarget> {
        validate_project_size(bytes.len() as u64)?;
        let targets = self.targets.lock().map_err(|_| "项目保存状态不可用。")?;
        let path = targets.get(token).ok_or(INVALID_TARGET)?;
        if !path.is_file() {
            return Err(INVALID_TARGET.into());
        }
        write_atomic(path, bytes)?;
        Ok(target(path, token.into()))
    }

    pub fn open_selected(&self, path: PathBuf) -> Result<ProjectFile> {
        validate_target_path(&path)?;
        let file = File::open(&path).map_err(|e| e.to_string())?;
        let metadata = file.metadata().map_err(|e| e.to_string())?;
        if !metadata.is_file() {
            return Err("请选择本机项目文件。".into());
        }
        validate_project_size(metadata.len())?;
        let mut bytes = Vec::new();
        file.take(MAX_PROJECT_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        validate_project_size(bytes.len() as u64)?;

        let mut targets = self.targets.lock().map_err(|_| "项目保存状态不可用。")?;
        let token = selected_token(&targets, &path)?;
        self.register(&mut targets, token.clone(), path.clone())?;
        let selected = target(&path, token);
        Ok(ProjectFile {
            name: selected.name,
            bytes,
            path: selected.path,
            token: selected.token,
        })
    }

    fn register(
        &self,
        targets: &mut HashMap<String, PathBuf>,
        token: String,
        path: PathBuf,
    ) -> Result<()> {
        if targets.get(&token) == Some(&path) {
            return Ok(());
        }
        let mut updated = targets.clone();
        updated.insert(token, path);
        if let Some(registry_path) = &self.registry_path {
            persist_registry(registry_path, &updated)?;
        }
        *targets = updated;
        Ok(())
    }
}

fn validate_target_path(path: &Path) -> Result<()> {
    let text = path.to_str().ok_or("项目保存路径无效。")?;
    if !path.is_absolute()
        || path.file_name().is_none()
        || text.len() > MAX_TARGET_PATH_BYTES
        || text.contains('\0')
        || path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("项目保存路径无效。".into());
    }
    Ok(())
}

fn read_registry(path: &Path) -> Result<HashMap<String, PathBuf>> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(error) => return Err(format!("无法读取项目保存位置记录：{error}")),
    };
    let invalid = "项目保存位置记录损坏，无法恢复之前的保存位置。";
    let metadata = file.metadata().map_err(|_| invalid)?;
    if !metadata.is_file() || metadata.len() > MAX_REGISTRY_BYTES {
        return Err(invalid.into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_REGISTRY_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| invalid)?;
    if bytes.len() as u64 > MAX_REGISTRY_BYTES {
        return Err(invalid.into());
    }
    let registry: TargetRegistry = serde_json::from_slice(&bytes).map_err(|_| invalid)?;
    if registry.version != 1 || registry.targets.len() > MAX_REGISTERED_TARGETS {
        return Err(invalid.into());
    }
    let mut targets = HashMap::new();
    for entry in registry.targets {
        if entry.token.len() != 64
            || !entry
                .token
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            || validate_target_path(&entry.path).is_err()
            || targets.insert(entry.token, entry.path).is_some()
        {
            return Err(invalid.into());
        }
    }
    Ok(targets)
}

fn persist_registry(path: &Path, targets: &HashMap<String, PathBuf>) -> Result<()> {
    let mut entries: Vec<_> = targets
        .iter()
        .map(|(token, path)| RegisteredTarget {
            token: token.clone(),
            path: path.clone(),
        })
        .collect();
    entries.sort_unstable_by(|left, right| left.token.cmp(&right.token));
    let bytes = serde_json::to_vec(&TargetRegistry {
        version: 1,
        targets: entries,
    })
    .map_err(|error| format!("无法记录项目保存位置：{error}"))?;
    if bytes.len() as u64 > MAX_REGISTRY_BYTES {
        return Err("项目保存位置记录已满，请清理不再使用的本地项目记录。".into());
    }
    let parent = path.parent().ok_or("项目保存位置记录目录无效。")?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("无法创建项目保存位置记录目录：{error}"))?;
    write_atomic(path, &bytes).map_err(|error| format!("无法记录项目保存位置：{error}"))
}

fn selected_token(targets: &HashMap<String, PathBuf>, path: &Path) -> Result<String> {
    if let Some((token, _)) = targets
        .iter()
        .find(|(_, registered)| registered.as_path() == path)
    {
        return Ok(token.clone());
    }
    if targets.len() >= MAX_REGISTERED_TARGETS {
        return Err("项目保存位置记录已满，请清理不再使用的本地项目记录。".into());
    }
    next_token(targets)
}

fn next_token(targets: &HashMap<String, PathBuf>) -> Result<String> {
    loop {
        let mut random = [0_u8; 32];
        getrandom::fill(&mut random).map_err(|e| format!("无法创建项目保存凭据：{e}"))?;
        let token: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        if !targets.contains_key(&token) {
            return Ok(token);
        }
    }
}

fn target(path: &Path, token: String) -> ProjectTarget {
    ProjectTarget {
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into(),
        path: path.to_string_lossy().into(),
        token,
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    replace_file(path, |file| file.write_all(bytes))
}

fn replace_file(path: &Path, write: impl FnOnce(&mut File) -> io::Result<()>) -> Result<()> {
    let parent = path.parent().ok_or("保存目录无效。")?;
    let mut staged = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    write(staged.as_file_mut()).map_err(|e| e.to_string())?;
    staged.as_file().sync_all().map_err(|e| e.to_string())?;
    staged.persist(path).map_err(|e| e.error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn first_save_registers_target_and_next_save_overwrites_it() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("项目.omedia");
        let registry = ProjectFiles::default();
        let first = registry.save_selected(path.clone(), b"first").unwrap();
        assert_eq!(first.name, "项目.omedia");
        assert_eq!(first.path, path.to_string_lossy());
        assert_eq!(first.token.len(), 64);
        assert_eq!(fs::read(&path).unwrap(), b"first");
        let overwritten = registry.save_registered(&first.token, b"updated").unwrap();
        assert_eq!(overwritten, first);
        assert_eq!(fs::read(path).unwrap(), b"updated");
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn save_as_registers_an_independent_target() {
        let directory = tempfile::tempdir().unwrap();
        let first_path = directory.path().join("first.omedia");
        let second_path = directory.path().join("second.omedia");
        let registry = ProjectFiles::default();
        let first = registry
            .save_selected(first_path.clone(), b"original")
            .unwrap();
        let second = registry
            .save_selected(second_path.clone(), b"copy")
            .unwrap();
        assert_ne!(first.token, second.token);
        registry
            .save_registered(&second.token, b"new copy")
            .unwrap();
        assert_eq!(fs::read(&first_path).unwrap(), b"original");
        assert_eq!(fs::read(&second_path).unwrap(), b"new copy");
        registry
            .save_registered(&first.token, b"new original")
            .unwrap();
        assert_eq!(fs::read(first_path).unwrap(), b"new original");
        assert_eq!(fs::read(second_path).unwrap(), b"new copy");
    }

    #[test]
    fn opening_registers_a_target_for_the_same_save_operation() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("opened.omedia");
        fs::write(&path, b"loaded").unwrap();
        let registry = ProjectFiles::default();
        let opened = registry.open_selected(path.clone()).unwrap();
        assert_eq!(opened.name, "opened.omedia");
        assert_eq!(opened.path, path.to_string_lossy());
        assert_eq!(opened.bytes, b"loaded");
        registry.save_registered(&opened.token, b"edited").unwrap();
        assert_eq!(fs::read(path).unwrap(), b"edited");
    }

    #[test]
    fn paths_and_tokens_from_other_sessions_cannot_authorize_a_save() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("private.omedia");
        let registry = ProjectFiles::default();
        let saved = registry.save_selected(path.clone(), b"protected").unwrap();
        assert!(registry.save_registered(&saved.path, b"invalid").is_err());
        assert!(registry
            .save_registered("unknown-token", b"invalid")
            .is_err());
        assert!(ProjectFiles::default()
            .save_registered(&saved.token, b"invalid")
            .is_err());
        assert_eq!(fs::read(path).unwrap(), b"protected");
    }

    #[test]
    fn partial_write_failure_preserves_original_file_and_authorization() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("keep.omedia");
        let registry = ProjectFiles::default();
        let saved = registry
            .save_selected(path.clone(), b"complete original")
            .unwrap();
        let failed = replace_file(&path, |file| {
            file.write_all(b"incomplete replacement")?;
            Err(io::Error::other("write interrupted"))
        });
        assert!(failed.is_err());
        assert_eq!(fs::read(&path).unwrap(), b"complete original");
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
        registry
            .save_registered(&saved.token, b"complete replacement")
            .unwrap();
        assert_eq!(fs::read(path).unwrap(), b"complete replacement");
    }

    #[test]
    fn unavailable_directory_preserves_registered_target_for_retry() {
        let directory = tempfile::tempdir().unwrap();
        let parent = directory.path().join("selected");
        let relocated = directory.path().join("temporarily moved");
        fs::create_dir(&parent).unwrap();
        let path = parent.join("keep.omedia");
        let registry = ProjectFiles::default();
        let saved = registry.save_selected(path.clone(), b"original").unwrap();
        fs::rename(&parent, &relocated).unwrap();
        assert!(registry
            .save_registered(&saved.token, b"incomplete")
            .is_err());
        assert_eq!(
            fs::read(relocated.join("keep.omedia")).unwrap(),
            b"original"
        );
        fs::rename(&relocated, &parent).unwrap();
        assert_eq!(
            registry.save_registered(&saved.token, b"retry").unwrap(),
            saved
        );
        assert_eq!(fs::read(path).unwrap(), b"retry");
    }

    #[test]
    fn failed_open_and_save_as_leave_existing_targets_intact() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("existing.omedia");
        let registry = ProjectFiles::default();
        let saved = registry.save_selected(path.clone(), b"original").unwrap();
        assert!(registry
            .open_selected(directory.path().join("missing.omedia"))
            .is_err());
        let invalid = directory.path().join("directory.omedia");
        fs::create_dir(&invalid).unwrap();
        assert!(registry
            .save_selected(invalid, b"cannot replace directory")
            .is_err());
        assert_eq!(registry.targets.lock().unwrap().len(), 1);
        assert_eq!(fs::read(&path).unwrap(), b"original");
        registry
            .save_registered(&saved.token, b"still writable")
            .unwrap();
        assert_eq!(fs::read(path).unwrap(), b"still writable");
    }

    #[test]
    fn persistent_targets_survive_restart_without_authorizing_paths_or_other_registries() {
        let directory = tempfile::tempdir().unwrap();
        let registry_path = directory.path().join("private/targets.json");
        let project_path = directory.path().join("saved.omedia");
        let opened_path = directory.path().join("opened.omedia");
        fs::write(&opened_path, b"opened").unwrap();
        let registry = ProjectFiles::persistent(registry_path.clone()).unwrap();
        let saved = registry
            .save_selected(project_path.clone(), b"first")
            .unwrap();
        let opened = registry.open_selected(opened_path.clone()).unwrap();
        assert_eq!(
            registry.open_selected(project_path.clone()).unwrap().token,
            saved.token
        );
        drop(registry);

        let restored = ProjectFiles::persistent(registry_path).unwrap();
        assert_eq!(
            restored.save_registered(&saved.token, b"updated").unwrap(),
            saved
        );
        restored.save_registered(&opened.token, b"edited").unwrap();
        assert!(restored
            .save_registered(&saved.path, b"unauthorized")
            .is_err());
        assert!(restored
            .save_registered(&"f".repeat(64), b"unauthorized")
            .is_err());
        let unrelated = ProjectFiles::persistent(directory.path().join("other.json")).unwrap();
        assert!(unrelated
            .save_registered(&saved.token, b"unauthorized")
            .is_err());
        assert_eq!(fs::read(project_path).unwrap(), b"updated");
        assert_eq!(fs::read(opened_path).unwrap(), b"edited");
        assert_eq!(
            fs::read_dir(directory.path().join("private"))
                .unwrap()
                .count(),
            1
        );
    }

    #[test]
    fn missing_or_replaced_registered_file_requires_explicit_save_as() {
        let directory = tempfile::tempdir().unwrap();
        let registry_path = directory.path().join("targets.json");
        let path = directory.path().join("original.omedia");
        let moved_path = directory.path().join("moved.omedia");
        let registry = ProjectFiles::persistent(registry_path.clone()).unwrap();
        let saved = registry.save_selected(path.clone(), b"original").unwrap();
        fs::rename(&path, &moved_path).unwrap();
        let registry = ProjectFiles::persistent(registry_path).unwrap();
        assert_eq!(
            registry
                .save_registered(&saved.token, b"invalid")
                .unwrap_err(),
            INVALID_TARGET
        );
        assert!(!path.exists());
        fs::create_dir(&path).unwrap();
        assert_eq!(
            registry
                .save_registered(&saved.token, b"invalid")
                .unwrap_err(),
            INVALID_TARGET
        );
        assert!(path.is_dir());
        fs::remove_dir(&path).unwrap();
        let replacement = registry
            .save_selected(path.clone(), b"explicit save as")
            .unwrap();
        assert_eq!(replacement.token, saved.token);
        assert_eq!(fs::read(&path).unwrap(), b"explicit save as");
        assert_eq!(fs::read(moved_path).unwrap(), b"original");
        fs::remove_file(&path).unwrap();
        assert_eq!(
            registry
                .save_registered(&saved.token, b"invalid")
                .unwrap_err(),
            INVALID_TARGET
        );
        assert!(!path.exists());
    }

    #[test]
    fn failed_registry_write_preserves_previous_memory_and_persisted_authorizations() {
        let directory = tempfile::tempdir().unwrap();
        let registry_path = directory.path().join("targets.json");
        let registry = ProjectFiles::persistent(registry_path.clone()).unwrap();
        let original_path = directory.path().join("original.omedia");
        let saved = registry
            .save_selected(original_path.clone(), b"original")
            .unwrap();
        let original_registry = fs::read(&registry_path).unwrap();
        let unavailable = directory.path().join("kept-targets.json");
        fs::rename(&registry_path, &unavailable).unwrap();
        fs::create_dir(&registry_path).unwrap();
        assert!(registry
            .save_selected(directory.path().join("copy.omedia"), b"copy")
            .is_err());
        assert_eq!(registry.targets.lock().unwrap().len(), 1);
        assert_eq!(fs::read(&unavailable).unwrap(), original_registry);
        registry
            .save_registered(&saved.token, b"still authorized")
            .unwrap();
        assert_eq!(fs::read(&original_path).unwrap(), b"still authorized");
        fs::remove_dir(&registry_path).unwrap();
        fs::rename(&unavailable, &registry_path).unwrap();
        drop(registry);
        ProjectFiles::persistent(registry_path)
            .unwrap()
            .save_registered(&saved.token, b"after restart")
            .unwrap();
        assert_eq!(fs::read(original_path).unwrap(), b"after restart");
    }

    #[test]
    fn malformed_or_unbounded_registry_is_rejected_without_overwriting_it() {
        let directory = tempfile::tempdir().unwrap();
        let registry_path = directory.path().join("targets.json");
        let entry = serde_json::json!({
            "token": "a".repeat(64),
            "path": directory.path().join("project.omedia")
        });
        let mut relative_entry = entry.clone();
        relative_entry["path"] = "relative.omedia".into();
        let mut invalid_token = entry.clone();
        invalid_token["token"] = "not-a-token".into();
        let invalid_documents = vec![
            b"{ incomplete".to_vec(),
            serde_json::to_vec(&serde_json::json!({ "version": 2, "targets": [] })).unwrap(),
            serde_json::to_vec(&serde_json::json!({ "version": 1, "targets": [], "extra": true })).unwrap(),
            serde_json::to_vec(&serde_json::json!({ "version": 1, "targets": [entry.clone(), entry.clone()] })).unwrap(),
            serde_json::to_vec(&serde_json::json!({ "version": 1, "targets": [relative_entry] })).unwrap(),
            serde_json::to_vec(&serde_json::json!({ "version": 1, "targets": [invalid_token] })).unwrap(),
            serde_json::to_vec(&serde_json::json!({ "version": 1, "targets": vec![entry; MAX_REGISTERED_TARGETS + 1] })).unwrap(),
            vec![b' '; MAX_REGISTRY_BYTES as usize + 1],
        ];
        for bytes in invalid_documents {
            fs::write(&registry_path, &bytes).unwrap();
            assert!(ProjectFiles::persistent(registry_path.clone()).is_err());
            assert_eq!(fs::read(&registry_path).unwrap(), bytes);
        }
        assert!(ProjectFiles::persistent(PathBuf::from("relative.json")).is_err());
    }

    #[test]
    fn failed_project_write_does_not_change_persistent_registry() {
        let directory = tempfile::tempdir().unwrap();
        let registry_path = directory.path().join("targets.json");
        let registry = ProjectFiles::persistent(registry_path.clone()).unwrap();
        let original_path = directory.path().join("original.omedia");
        let saved = registry
            .save_selected(original_path.clone(), b"original")
            .unwrap();
        let original_registry = fs::read(&registry_path).unwrap();
        assert!(registry
            .save_selected(directory.path().join("missing/copy.omedia"), b"copy")
            .is_err());
        assert!(registry
            .open_selected(directory.path().join("missing.omedia"))
            .is_err());
        assert_eq!(fs::read(&registry_path).unwrap(), original_registry);
        assert_eq!(registry.targets.lock().unwrap().len(), 1);
        drop(registry);
        ProjectFiles::persistent(registry_path)
            .unwrap()
            .save_registered(&saved.token, b"retry")
            .unwrap();
        assert_eq!(fs::read(original_path).unwrap(), b"retry");
    }

    #[test]
    fn only_main_window_is_authorized_and_size_is_bounded() {
        assert!(require_main_window("main").is_ok());
        assert!(require_main_window("capture-picker").is_err());
        assert!(require_main_window("").is_err());
        assert!(validate_project_size(MAX_PROJECT_BYTES).is_ok());
        assert!(validate_project_size(MAX_PROJECT_BYTES + 1).is_err());
    }
}
