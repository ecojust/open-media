//! Optional native acceleration shares the verified model download lifecycle.
use super::*;

const PACKAGE_ID: &str = "native-gpu-runtime";

pub(super) fn append_package(catalog: &mut Catalog) -> Result<()> {
    if catalog.native_acceleration_runtime_id.is_empty() {
        return Ok(());
    }
    let selected =
        runtime_packages::select(&catalog.native_acceleration_runtime_id, &catalog.runtimes)?;
    let Some(runtime) = selected.filter(|_| runtime_packages::cuda_available()) else {
        return Ok(());
    };
    if runtime.archive.kind != runtime_packages::RuntimeKind::Native {
        return Err("原生加速组件类型无效。".into());
    }
    if catalog
        .models
        .iter()
        .any(|package| package.id == PACKAGE_ID)
    {
        return Err("原生加速组件标识与音色重复。".into());
    }
    catalog.models.push(Package {
        id: PACKAGE_ID.into(),
        version: runtime.version,
        model_size: 0,
        download_size: 0,
        files: Vec::new(),
        voices: Vec::new(),
        model: serde_json::from_value(serde_json::json!({"kind": "matcha", "sampleRate": 16000}))
            .map_err(|_| "原生加速组件配置无效。")?,
        runtime_id: runtime.id.clone(),
        accelerated_runtime_id: String::new(),
        fallback_runtime: None,
        runtime_only: true,
        license: String::new(),
        usage_note: String::new(),
        runtime: Some(runtime),
    });
    Ok(())
}

pub(super) fn resolve(
    package: &Package,
    root: &Path,
    bundled: Option<&SpeechRuntime>,
) -> Option<Result<SpeechRuntime>> {
    package.runtime_only.then(|| {
        let mut speech = bundled.ok_or("加速组件需要完整的内置语音资源。")?.clone();
        let runtime = package.runtime.as_ref().ok_or("加速组件不支持当前系统。")?;
        let store = root.parent().ok_or("加速组件目录无效。")?;
        let installed = runtime_packages::path(store, runtime);
        let executable = checked_path(&installed, &runtime.archive.executable, false)?;
        speech.native_cpu_fallback = Some(speech.executable.clone());
        speech.executable = executable;
        speech.script = None;
        Ok(speech)
    })
}

fn native_voice(id: &str) -> bool {
    matches!(
        id,
        "matcha_zh_en_female" | "zipvoice_zh_female" | "zipvoice_zh_male"
    )
}

impl SpeechModels {
    pub(crate) fn decorate_native_acceleration(&self, voices: &mut [SpeechVoice]) {
        let Some(package) = self.catalog.iter().find(|package| package.runtime_only) else {
            return;
        };
        let Some(runtime) = &package.runtime else {
            return;
        };
        let Ok(mut state) = self.owner.downloads.lock() else {
            return;
        };
        let Some(entry) = state.entries.get_mut(&package.id) else {
            return;
        };
        if entry.state == State::Ready && !display_stamps_unchanged(&entry.stamps) {
            entry.state = State::Failed;
            entry.runtime = None;
            entry.error = Some("加速组件文件缺失或已更改，请重新下载。".into());
        }
        let status = match entry.state {
            State::NotDownloaded => "upgrade-available",
            State::Downloading => "upgrade-downloading",
            State::Verifying => "upgrade-verifying",
            State::Failed => "upgrade-failed",
            State::Ready => "ready",
        };
        for voice in voices.iter_mut().filter(|voice| {
            native_voice(&voice.id) && matches!(voice.status.as_deref(), Some("ready" | "bundled"))
        }) {
            voice.runtime_download_id = Some(PACKAGE_ID.into());
            voice.runtime_status = Some(status.into());
            voice.runtime_size = Some(runtime.archive.size);
            voice.runtime_error = entry.error.clone();
            voice.download_size = Some(runtime.archive.size);
            voice.downloaded_bytes = Some(entry.downloaded);
            voice.download_source = entry.download_source.clone();
            voice.download_session = Some(entry.download_session);
        }
    }

    pub(crate) fn native_runtime_for(&self, cpu: &SpeechRuntime) -> SpeechRuntime {
        if !matches!(
            cpu.model.kind,
            ModelKind::Matcha | ModelKind::Zipvoice | ModelKind::Kokoro
        ) {
            return cpu.clone();
        }
        let Ok(mut state) = self.owner.downloads.lock() else {
            return cpu.clone();
        };
        let Some(entry) = state
            .entries
            .get_mut(PACKAGE_ID)
            .filter(|entry| entry.state == State::Ready)
        else {
            return cpu.clone();
        };
        if !stamps_unchanged(&entry.stamps) {
            entry.state = State::Failed;
            entry.runtime = None;
            entry.error = Some("加速组件文件缺失或已更改，请重新下载。".into());
            return cpu.clone();
        }
        let Some(accelerated) = &entry.runtime else {
            return cpu.clone();
        };
        let mut speech = cpu.clone();
        speech.native_cpu_fallback = Some(cpu.executable.clone());
        speech.executable = accelerated.executable.clone();
        speech.script = None;
        speech
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, SpeechModels, SpeechRuntime) {
        let directory = tempfile::tempdir().unwrap();
        let helper = directory.path().join("accelerated-helper");
        fs::write(&helper, b"verified fixture helper").unwrap();
        let metadata = fs::metadata(&helper).unwrap();
        let voice: SpeechVoice = serde_json::from_value(serde_json::json!({
            "id":"zipvoice_zh_male", "name":"测试声音", "language":"zh-CN", "speakerId":0, "status":"ready"
        })).unwrap();
        let cpu = SpeechRuntime {
            root: directory.path().join("existing-model"),
            executable: directory.path().join("bundled-cpu-helper"),
            script: None, native_cpu_fallback: None, python_cpu_fallback: None,
            model: serde_json::from_value(serde_json::json!({"kind":"zipvoice", "sampleRate":24000, "encoder":"original.onnx"})).unwrap(),
            voices: vec![voice],
        };
        let mut accelerated = cpu.clone();
        accelerated.executable = helper.clone();
        let mut package: Package = serde_json::from_value(serde_json::json!({
            "id":PACKAGE_ID,"version":1,"modelSize":0,"downloadSize":0,"files":[],"voices":[],
            "model":{"kind":"matcha","sampleRate":16000},"runtimeId":"native-cuda-v1"
        }))
        .unwrap();
        package.runtime_only = true;
        package.runtime = Some(runtime_packages::SelectedRuntime {
            id: "native-cuda-v1".into(), version:1, platform:"windows-x64".into(),
            archive: serde_json::from_value(serde_json::json!({
                "url":"https://github.com/ecojust/open-media/releases/download/test/native.zip", "size":1234,
                "unpackedSize":2345,"sha256":"a".repeat(64),"manifestSha256":"b".repeat(64),
                "executable":"engine.exe","script":"engine.exe","kind":"native"
            })).unwrap(),
        });
        let mut downloads = Downloads::default();
        downloads.entries.insert(
            PACKAGE_ID.into(),
            Entry {
                state: State::Ready,
                runtime: Some(accelerated),
                downloaded: 1234,
                stamps: vec![FileStamp {
                    path: helper,
                    size: metadata.len(),
                    modified: metadata.modified().ok(),
                    defer_display_check: false,
                }],
                ..Entry::default()
            },
        );
        let manager = SpeechModels {
            root: directory.path().to_owned(),
            catalog: Arc::new(vec![package]),
            bundled: Ok(cpu.clone()),
            owner: Arc::new(Owner {
                downloads: Arc::new(Mutex::new(downloads)),
            }),
        };
        (directory, manager, cpu)
    }

    #[test]
    fn verified_native_acceleration_preserves_the_exact_model_and_cpu_helper() {
        let (_directory, manager, cpu) = fixture();
        let accelerated = manager.native_runtime_for(&cpu);
        assert_eq!(accelerated.root, cpu.root);
        assert_eq!(accelerated.model.encoder, "original.onnx");
        assert!(accelerated.model.kind == ModelKind::Zipvoice);
        assert_eq!(accelerated.voices[0].id, cpu.voices[0].id);
        assert_ne!(accelerated.executable, cpu.executable);
        assert_eq!(
            accelerated.native_cpu_fallback.as_ref(),
            Some(&cpu.executable)
        );
    }

    #[test]
    fn native_upgrade_never_disables_existing_cpu_voices_and_tracks_the_shared_download() {
        let (_directory, manager, cpu) = fixture();
        for (state, expected) in [
            (State::NotDownloaded, "upgrade-available"),
            (State::Downloading, "upgrade-downloading"),
            (State::Verifying, "upgrade-verifying"),
            (State::Failed, "upgrade-failed"),
        ] {
            manager
                .owner
                .downloads
                .lock()
                .unwrap()
                .entries
                .get_mut(PACKAGE_ID)
                .unwrap()
                .state = state;
            let mut voices = cpu.voices.clone();
            manager.decorate_native_acceleration(&mut voices);
            assert_eq!(voices[0].status.as_deref(), Some("ready"));
            assert_eq!(voices[0].runtime_status.as_deref(), Some(expected));
            assert_eq!(voices[0].runtime_download_id.as_deref(), Some(PACKAGE_ID));
            assert_eq!(voices[0].download_size, Some(1234));
            assert_eq!(manager.native_runtime_for(&cpu).executable, cpu.executable);
        }
    }

    #[test]
    fn corrupt_native_component_falls_back_and_exposes_a_repairable_status() {
        let (directory, manager, cpu) = fixture();
        fs::write(directory.path().join("accelerated-helper"), b"changed").unwrap();
        assert_eq!(manager.native_runtime_for(&cpu).executable, cpu.executable);
        let mut voices = cpu.voices.clone();
        manager.decorate_native_acceleration(&mut voices);
        assert_eq!(voices[0].runtime_status.as_deref(), Some("upgrade-failed"));
        assert!(voices[0].runtime_error.is_some());
    }
}
