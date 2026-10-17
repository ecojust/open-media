pub mod capture;
#[cfg(any(target_os = "macos", test))]
pub mod capture_service;
#[cfg(any(feature = "desktop", test))]
pub mod capture_picker;
#[cfg(any(target_os = "windows", test))]
mod capture_windows;
pub mod engine;
pub mod clip_filters;
pub mod chroma_key;
pub mod preview;
pub mod project_files;
#[cfg(any(feature = "desktop", test))]
pub mod image_clipboard;
pub mod speech;
mod speech_models;
mod speech_chinese;
#[cfg(any(feature = "desktop", test))]
pub mod screenshot;
#[cfg(feature = "desktop")]
pub mod screenshot_shortcut;
#[cfg(any(feature = "desktop", test))]
pub mod recording_controls;
#[cfg(test)]
mod tests;

#[cfg(feature = "desktop")]
mod desktop {
    use crate::{
        capture::{
            self, CaptureDevice, CaptureManager, CaptureOptions, CaptureStartCancellation,
            CaptureStatus,
        },
        capture_picker::{self, CapturePicker, PickerContext, PickerPreferences, PickerSelection},
        engine::{self, Asset, JobManager, MediaJob, MediaStore, Runtime, RuntimeStatus},
        preview::{self, PreviewResult},
        project_files::{self, ProjectFile, ProjectFiles, ProjectTarget},
        image_clipboard::{self, ImageClipboard},
        recording_controls::{ControlsAction, ControlsManager, ControlsSnapshot},
        speech::{SpeechJob, SpeechManager, SpeechRequest, SpeechStatus},
    };
    use serde_json::Value;
    use std::{
        fs,
        path::PathBuf,
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc, Mutex,
        },
    };
    use tauri::{Emitter, Manager, State};
    use tauri_plugin_dialog::DialogExt;

    #[derive(Clone)]
    pub struct MediaState {
        runtime: Arc<Mutex<engine::Result<Runtime>>>,
        store: MediaStore,
        jobs: JobManager,
        speech: SpeechManager,
        capture: Arc<Mutex<CaptureManager>>,
        capture_starts: Arc<CaptureStartCancellation>,
        resource: PathBuf,
        settings: PathBuf,
    }
    #[derive(Default)]
    pub struct Closing(AtomicBool);
    impl MediaState {
        fn runtime(&self) -> engine::Result<Runtime> {
            self.runtime
                .lock()
                .map_err(|_| "媒体引擎状态不可用。")?
                .clone()
        }
    }
    fn blocking<T: Send + 'static>(
        task: impl FnOnce() -> engine::Result<T> + Send + 'static,
    ) -> impl std::future::Future<Output = engine::Result<T>> {
        async move {
            tauri::async_runtime::spawn_blocking(task)
                .await
                .map_err(|e| format!("操作未能完成：{e}"))?
        }
    }

    #[tauri::command]
    pub fn get_runtime_status(state: State<'_, MediaState>) -> RuntimeStatus {
        Runtime::status(&state.runtime.lock().unwrap())
    }
    #[tauri::command]
    pub async fn select_runtime(
        app: tauri::AppHandle,
        state: State<'_, MediaState>,
    ) -> engine::Result<RuntimeStatus> {
        let state = state.inner().clone();
        blocking(move || {
            let Some(selected) = app
                .dialog()
                .file()
                .set_title("选择媒体编码引擎；同目录需包含媒体探测程序")
                .blocking_pick_file()
            else {
                return Ok(Runtime::status(&state.runtime.lock().unwrap()));
            };
            let path = selected.into_path().map_err(|_| "请选择本机程序。")?;
            let runtime = Runtime::discover(Some(&state.resource), Some(&path))?;
            if runtime.source != "用户选择" {
                return Err("选择的引擎或同目录的探测程序不可用。".into());
            }
            fs::write(&state.settings, path.to_string_lossy().as_bytes())
                .map_err(|e| e.to_string())?;
            *state.runtime.lock().unwrap() = Ok(runtime);
            let status = Runtime::status(&state.runtime.lock().unwrap());
            Ok(status)
        })
        .await
    }
    #[tauri::command]
    pub async fn pick_media_assets(
        app: tauri::AppHandle,
        state: State<'_, MediaState>,
    ) -> engine::Result<Vec<Asset>> {
        let state = state.inner().clone();
        blocking(move || {
            let runtime = state.runtime()?;
            let Some(paths) = app
                .dialog()
                .file()
                .add_filter(
                    "媒体文件",
                    &[
                        "mp4", "mov", "mkv", "webm", "avi", "m4v", "mpeg", "mpg", "mp3", "wav",
                        "aac", "m4a", "flac", "ogg", "opus", "png", "jpg", "jpeg", "webp", "bmp",
                        "tif", "tiff", "gif", "avif", "heic",
                    ],
                )
                .blocking_pick_files()
            else {
                return Ok(vec![]);
            };
            paths
                .into_iter()
                .map(|p| {
                    let path = p.into_path().map_err(|_| "请选择本机媒体文件。")?;
                    state.store.import(&runtime, &path, None)
                })
                .collect()
        })
        .await
    }
    #[tauri::command]
    pub async fn import_blob_asset(
        bytes: Vec<u8>,
        name: String,
        state: State<'_, MediaState>,
    ) -> engine::Result<Asset> {
        let state = state.inner().clone();
        blocking(move || state.store.import_bytes(&state.runtime()?, &bytes, &name)).await
    }
    #[tauri::command]
    pub async fn create_media_preview(
        asset: Value,
        format: Option<String>,
        state: State<'_, MediaState>,
    ) -> engine::Result<PreviewResult> {
        let state = state.inner().clone();
        blocking(move || {
            preview::create_preview(&state.store, &state.runtime()?, &asset, format.as_deref())
        })
        .await
    }
    #[tauri::command]
    pub async fn begin_media_job(
        spec: Value,
        app: tauri::AppHandle,
        state: State<'_, MediaState>,
    ) -> engine::Result<Option<MediaJob>> {
        let state = state.inner().clone();
        blocking(move || {
            let name = engine::suggested_output(&spec)?;
            let runtime = state.runtime()?;
            let plan = engine::build_plan(&state.store, &runtime, &spec)?;
            let extension = PathBuf::from(&name)
                .extension()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            let Some(selected) = app
                .dialog()
                .file()
                .set_file_name(&name)
                .add_filter("导出媒体", &[extension.as_str()])
                .blocking_save_file()
            else {
                return Ok(None);
            };
            let mut output = selected.into_path().map_err(|_| "请选择本机保存位置。")?;
            if output.extension().is_none() {
                output.set_extension(&extension);
            }
            let canonical_parent = output
                .parent()
                .ok_or("保存目录无效。")?
                .canonicalize()
                .map_err(|e| e.to_string())?;
            if canonical_parent.starts_with(&state.store.root) {
                return Err("请选择素材库以外的位置，避免覆盖原始素材。".into());
            }
            state.jobs.begin(&runtime, plan, output).map(Some)
        })
        .await
    }
    #[tauri::command]
    pub fn get_media_jobs(state: State<'_, MediaState>) -> Vec<MediaJob> {
        state.jobs.list()
    }
    #[tauri::command]
    pub fn cancel_media_job(id: String, state: State<'_, MediaState>) -> engine::Result<()> {
        state.jobs.cancel(&id)
    }
    #[tauri::command]
    pub async fn get_speech_status(state: State<'_, MediaState>) -> engine::Result<SpeechStatus> {
        let speech = state.speech.clone();
        blocking(move || Ok(speech.status())).await
    }
    #[tauri::command]
    pub async fn begin_speech_model_download(
        model_id: String,
        state: State<'_, MediaState>,
    ) -> engine::Result<SpeechStatus> {
        let speech = state.speech.clone();
        blocking(move || speech.begin_model_download(&model_id)).await
    }
    #[tauri::command]
    pub async fn cancel_speech_model_download(
        model_id: String,
        state: State<'_, MediaState>,
    ) -> engine::Result<SpeechStatus> {
        let speech = state.speech.clone();
        blocking(move || speech.cancel_model_download(&model_id)).await
    }
    #[tauri::command]
    pub async fn begin_speech_job(
        request: SpeechRequest,
        state: State<'_, MediaState>,
    ) -> engine::Result<SpeechJob> {
        let state = state.inner().clone();
        blocking(move || state.speech.begin(state.runtime()?, state.store.clone(), request)).await
    }
    #[tauri::command]
    pub fn get_speech_job(id: String, state: State<'_, MediaState>) -> engine::Result<SpeechJob> {
        state.speech.get(&id)
    }
    #[tauri::command]
    pub fn cancel_speech_job(id: String, state: State<'_, MediaState>) -> engine::Result<()> {
        state.speech.cancel(&id)
    }
    #[tauri::command]
    pub async fn discard_speech_job(id: String, state: State<'_, MediaState>) -> engine::Result<()> {
        let speech = state.speech.clone();
        blocking(move || speech.discard(&id)).await
    }
    #[tauri::command]
    pub fn accept_speech_jobs(ids: Vec<String>, state: State<'_, MediaState>) -> engine::Result<()> {
        state.speech.accept(&ids)
    }
    #[tauri::command]
    pub async fn list_capture_devices(
        request_permission: Option<bool>,
        state: State<'_, MediaState>,
    ) -> engine::Result<Vec<CaptureDevice>> {
        let state = state.inner().clone();
        blocking(move || {
            capture::list_devices_with_resource(
                &state.runtime()?,
                &state.resource,
                request_permission.unwrap_or(false),
            )
        })
        .await
    }
    #[tauri::command]
    pub async fn pick_capture_source(
        request_id: String,
        preferences: PickerPreferences,
        window: tauri::WebviewWindow,
        app: tauri::AppHandle,
        state: State<'_, MediaState>,
        picker: State<'_, CapturePicker>,
    ) -> engine::Result<Option<PickerSelection>> {
        capture_picker::require_main(&window)?;
        {
            let mut capture = state
                .capture
                .try_lock()
                .map_err(|_| "录制操作正在处理，请稍后再选择录制范围。")?;
            if capture.status().state != "idle" {
                return Err("请先停止当前录制，再选择新的录制范围。".into());
            }
        }
        let receiver = picker.start(
            &app,
            request_id,
            preferences,
            state.runtime()?,
            state.resource.clone(),
        )?;
        blocking(move || {
            receiver
                .recv()
                .map_err(|_| "录制选择已关闭，请重试。".to_string())?
        })
        .await
    }
    #[tauri::command]
    pub fn cancel_capture_picker(
        request_id: String,
        window: tauri::WebviewWindow,
        app: tauri::AppHandle,
        picker: State<'_, CapturePicker>,
    ) -> engine::Result<()> {
        capture_picker::require_main(&window)?;
        picker.cancel(&app, &request_id)
    }
    #[tauri::command]
    pub fn get_capture_picker_context(
        request_id: String,
        window: tauri::WebviewWindow,
        picker: State<'_, CapturePicker>,
    ) -> engine::Result<PickerContext> {
        picker.context(&request_id, window.label())
    }
    #[tauri::command]
    pub fn capture_picker_ready(
        request_id: String,
        window: tauri::WebviewWindow,
        app: tauri::AppHandle,
        picker: State<'_, CapturePicker>,
    ) -> engine::Result<()> {
        picker.ready(&app, &request_id, window.label())
    }
    #[tauri::command]
    pub fn complete_capture_picker(
        request_id: String,
        selection: Option<PickerSelection>,
        window: tauri::WebviewWindow,
        app: tauri::AppHandle,
        picker: State<'_, CapturePicker>,
    ) -> engine::Result<()> {
        picker.complete(&app, &request_id, window.label(), selection)
    }
    #[tauri::command]
    pub async fn configure_screenshot_shortcut(
        shortcut: Option<String>,
        window: tauri::WebviewWindow,
        state: State<'_, crate::screenshot_shortcut::ShortcutManager>,
    ) -> engine::Result<Option<String>> {
        capture_picker::require_main(&window)?;
        state.inner().clone().configure(shortcut).await
    }
    #[tauri::command]
    pub fn show_main_window(window: tauri::WebviewWindow) -> engine::Result<()> {
        capture_picker::require_main(&window)?;
        window.unminimize().map_err(|error| error.to_string())?;
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())
    }
    #[tauri::command]
    pub async fn capture_screenshot(
        selection: PickerSelection,
        window: tauri::WebviewWindow,
        state: State<'_, MediaState>,
    ) -> engine::Result<Asset> {
        capture_picker::require_main(&window)?;
        let state = state.inner().clone();
        blocking(move || {
            let mut capture = state.capture.try_lock()
                .map_err(|_| "录制正在处理，请稍后再截屏。")?;
            if capture.status().state != "idle" {
                return Err("请先停止当前录制，再截屏。".into());
            }
            crate::screenshot::capture(&state.runtime()?, &state.store, &selection)
        }).await
    }
    #[tauri::command]
    pub async fn get_capture_status(app: tauri::AppHandle, state: State<'_, MediaState>) -> engine::Result<CaptureStatus> {
        let state = state.inner().clone();
        blocking(move || {
            let mut capture = state.capture.lock().unwrap();
            let status = capture.status();
            sync_recording_controls(&app, &status, false, false, None);
            Ok(status)
        }).await
    }
    fn sync_recording_controls(app: &tauri::AppHandle, status: &CaptureStatus, busy: bool, microphone_pending: bool, error: Option<String>) {
        let controls = app.state::<ControlsManager>();
        if status.state == "idle" {
            // The protected window is published before the capture child starts.
            // A concurrent status read must not remove it during that preparation.
            if controls.snapshot().is_ok_and(|snapshot| snapshot.phase != "starting") {
                controls.close(app);
            }
        } else {
            let _ = controls.sync(app, ControlsSnapshot {
                phase: status.state.clone(), elapsed: status.elapsed,
                muted: status.muted, audio_available: status.audio_available, microphone_enabled: status.microphone_enabled, microphone_pending, busy,
                error: error.or_else(|| status.error.clone()),
            });
        }
    }
    async fn change_capture(
        app: tauri::AppHandle,
        state: MediaState,
        microphone_pending: bool,
        change: impl FnOnce(&mut CaptureManager) -> engine::Result<CaptureStatus> + Send + 'static,
    ) -> engine::Result<CaptureStatus> {
        blocking(move || {
            let mut capture = state.capture.lock().unwrap();
            sync_recording_controls(&app, &capture.status(), true, microphone_pending, None);
            let result = change(&mut capture);
            let status = capture.status();
            if let Some((source, region)) = capture.controls_target() {
                let _ = app.state::<ControlsManager>().set_target(&app, source, region);
            }
            sync_recording_controls(&app, &status, false, false, result.as_ref().err().cloned());
            result
        }).await
    }
    #[tauri::command]
    pub fn capture_controls_ready(app: tauri::AppHandle, window: tauri::WebviewWindow) -> engine::Result<ControlsSnapshot> {
        app.state::<ControlsManager>().ready(&app, window.label())
    }
    #[tauri::command]
    pub fn capture_controls_action(app: tauri::AppHandle, window: tauri::WebviewWindow, action: ControlsAction) -> engine::Result<()> {
        app.state::<ControlsManager>().action(&app, window.label(), action)
    }
    #[tauri::command]
    pub async fn start_capture(
        options: CaptureOptions,
        app: tauri::AppHandle,
        window: tauri::WebviewWindow,
        state: State<'_, MediaState>,
    ) -> engine::Result<CaptureStatus> {
        project_files::require_main_window(window.label())?;
        let state = state.inner().clone();
        let request_id = options.request_id.clone().unwrap_or_else(engine::new_id);
        let cancelled = state.capture_starts.token(&request_id)?;
        let controls = app.state::<ControlsManager>().inner().clone();
        let preparation = controls.prepare(&app, ControlsSnapshot::default()).await;
        if let Err(error) = preparation {
            state.capture_starts.complete(&request_id);
            return Err(error);
        }
        let worker_state = state.clone();
        let worker_app = app.clone();
        let result = blocking(move || {
            let mut capture = worker_state.capture.lock().unwrap();
            let status = capture.start_cancellable(&worker_state.runtime()?, options, &cancelled)?;
            if let Some((source, region)) = capture.controls_target() {
                let _ = worker_app.state::<ControlsManager>().set_target(&worker_app, source, region);
            }
            sync_recording_controls(&worker_app, &status, false, false, None);
            Ok(status)
        }).await;
        state.capture_starts.complete(&request_id);
        if result.is_err() { controls.close(&app); }
        result
    }
    #[tauri::command]
    pub fn cancel_capture_start(
        request_id: String,
        state: State<'_, MediaState>,
    ) -> engine::Result<()> {
        state.capture_starts.cancel(&request_id)
    }
    #[tauri::command]
    pub async fn pause_capture(app: tauri::AppHandle, window: tauri::WebviewWindow, state: State<'_, MediaState>) -> engine::Result<CaptureStatus> {
        project_files::require_main_window(window.label())?;
        change_capture(app, state.inner().clone(), false, |capture| capture.pause()).await
    }
    #[tauri::command]
    pub async fn resume_capture(app: tauri::AppHandle, window: tauri::WebviewWindow, state: State<'_, MediaState>) -> engine::Result<CaptureStatus> {
        project_files::require_main_window(window.label())?;
        change_capture(app, state.inner().clone(), false, |capture| capture.resume()).await
    }
    #[tauri::command]
    pub async fn set_capture_muted(muted: bool, app: tauri::AppHandle, window: tauri::WebviewWindow, state: State<'_, MediaState>) -> engine::Result<CaptureStatus> {
        project_files::require_main_window(window.label())?;
        change_capture(app, state.inner().clone(), false, move |capture| capture.set_muted(muted)).await
    }
    #[tauri::command]
    pub async fn set_capture_microphone(enabled: bool, request_id: String, app: tauri::AppHandle, window: tauri::WebviewWindow, state: State<'_, MediaState>) -> engine::Result<CaptureStatus> {
        project_files::require_main_window(window.label())?;
        let state = state.inner().clone();
        let cancelled = state.capture_starts.token(&request_id)?;
        let result = change_capture(app, state.clone(), true, move |capture| capture.set_microphone_enabled_cancellable(enabled, &cancelled)).await;
        state.capture_starts.complete(&request_id);
        result
    }
    #[tauri::command]
    pub async fn stop_capture(app: tauri::AppHandle, window: tauri::WebviewWindow, state: State<'_, MediaState>) -> engine::Result<Option<Asset>> {
        project_files::require_main_window(window.label())?;
        let state = state.inner().clone();
        blocking(move || {
            let mut capture = state.capture.lock().unwrap();
            let mut stopping = capture.status();
            if stopping.state != "idle" { stopping.state = "stopping".into(); }
            sync_recording_controls(&app, &stopping, true, false, None);
            let result = capture.stop(&state.store);
            sync_recording_controls(&app, &capture.status(), false, false, result.as_ref().err().cloned());
            result
        }).await
    }
    #[tauri::command]
    pub async fn save_bytes(
        name: String,
        bytes: Vec<u8>,
        app: tauri::AppHandle,
    ) -> engine::Result<Option<String>> {
        blocking(move || {
            if bytes.len() > 1024 * 1024 * 1024 {
                return Err("文件超过 1 GB 保存上限。".into());
            }
            let Some(selected) = app
                .dialog()
                .file()
                .set_file_name(&name)
                .blocking_save_file()
            else {
                return Ok(None);
            };
            let path = selected.into_path().map_err(|_| "请选择本机保存位置。")?;
            let parent = path.parent().ok_or("保存目录无效。")?;
            let temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
            fs::write(temp.path(), &bytes).map_err(|e| e.to_string())?;
            temp.as_file().sync_all().map_err(|e| e.to_string())?;
            temp.persist(&path).map_err(|e| e.error.to_string())?;
            Ok(Some(path.to_string_lossy().into()))
        })
        .await
    }
    #[tauri::command]
    pub async fn copy_image_to_clipboard(
        request: tauri::ipc::Request<'_>,
        window: tauri::WebviewWindow,
        state: State<'_, ImageClipboard>,
    ) -> engine::Result<()> {
        image_clipboard::require_main_window(window.label())?;
        let bytes = match request.body() {
            tauri::ipc::InvokeBody::Raw(bytes) => bytes,
            _ => return Err("图片复制需要二进制像素数据。".into()),
        };
        image_clipboard::validate_packet(bytes)?;
        let packet = bytes.to_vec();
        let state = state.inner().clone();
        blocking(move || state.copy(packet)).await
    }
    #[tauri::command]
    pub async fn save_project_file(
        name: String,
        bytes: Vec<u8>,
        token: Option<String>,
        app: tauri::AppHandle,
        window: tauri::WebviewWindow,
        state: State<'_, ProjectFiles>,
    ) -> engine::Result<Option<ProjectTarget>> {
        project_files::require_main_window(window.label())?;
        project_files::validate_project_size(bytes.len() as u64)?;
        let state = state.inner().clone();
        blocking(move || {
            if let Some(token) = token {
                return state.save_registered(&token, &bytes).map(Some);
            }
            let Some(selected) = app
                .dialog()
                .file()
                .add_filter("媒体项目", &["omedia"])
                .set_file_name(&name)
                .blocking_save_file()
            else {
                return Ok(None);
            };
            let path = selected.into_path().map_err(|_| "请选择本机保存位置。")?;
            state.save_selected(path, &bytes).map(Some)
        })
        .await
    }
    #[tauri::command]
    pub async fn open_project_file(
        app: tauri::AppHandle,
        window: tauri::WebviewWindow,
        state: State<'_, ProjectFiles>,
    ) -> engine::Result<Option<ProjectFile>> {
        project_files::require_main_window(window.label())?;
        let state = state.inner().clone();
        blocking(move || {
            let Some(selected) = app
                .dialog()
                .file()
                .add_filter("媒体项目", &["omedia", "zip"])
                .blocking_pick_file()
            else {
                return Ok(None);
            };
            let path = selected.into_path().map_err(|_| "请选择本机项目文件。")?;
            state.open_selected(path).map(Some)
        })
        .await
    }
    #[tauri::command]
    pub fn close_native_window(
        app: tauri::AppHandle,
        state: State<'_, Closing>,
    ) -> engine::Result<()> {
        if state.0.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        let handle = app.clone();
        if let Err(error) = app.run_on_main_thread(move || handle.exit(0)) {
            state.0.store(false, Ordering::SeqCst);
            return Err(error.to_string());
        }
        Ok(())
    }

    pub fn run() {
        let app = tauri::Builder::default()
            .plugin(tauri_plugin_dialog::init())
            .manage(Closing::default())
            .manage(CapturePicker::default())
            .manage(ProjectFiles::default())
            .manage(ImageClipboard::default())
            .manage(ControlsManager::default())
            .setup(|app| {
                app.manage(crate::screenshot_shortcut::ShortcutManager::new(app.handle().clone()));
                let data = app.path().app_data_dir()?;
                fs::create_dir_all(&data)?;
                let resource = app.path().resource_dir()?;
                let settings = data.join("media-engine-path.txt");
                let selected = fs::read_to_string(&settings).ok().map(PathBuf::from);
                let store = MediaStore::new(&data).map_err(std::io::Error::other)?;
                let runtime = Runtime::discover(Some(&resource), selected.as_deref());
                app.manage(MediaState {
                    runtime: Arc::new(Mutex::new(runtime)),
                    store,
                    jobs: JobManager::default(),
                    speech: SpeechManager::new(&data, &resource).map_err(std::io::Error::other)?,
                    capture: Arc::new(Mutex::new(CaptureManager::default())),
                    capture_starts: Arc::new(CaptureStartCancellation::default()),
                    resource,
                    settings,
                });
                Ok(())
            })
            .on_window_event(|window, event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    if window.label() == crate::recording_controls::WINDOW_LABEL {
                        api.prevent_close();
                        return;
                    }
                    window
                        .state::<CapturePicker>()
                        .cancel_window(window.app_handle(), window.label());
                    if window.label() != "main" {
                        return;
                    }
                    let closing = window.state::<Closing>();
                    if !closing.0.load(Ordering::SeqCst) {
                        api.prevent_close();
                        let _ = window.emit("native-close-requested", ());
                    }
                }
                if matches!(event, tauri::WindowEvent::Destroyed) {
                    window
                        .state::<CapturePicker>()
                        .cancel_window(window.app_handle(), window.label());
                }
            })
            .invoke_handler(tauri::generate_handler![
                get_runtime_status,
                select_runtime,
                pick_media_assets,
                import_blob_asset,
                create_media_preview,
                begin_media_job,
                get_media_jobs,
                cancel_media_job,
                get_speech_status,
                begin_speech_model_download,
                cancel_speech_model_download,
                begin_speech_job,
                get_speech_job,
                cancel_speech_job,
                discard_speech_job,
                accept_speech_jobs,
                configure_screenshot_shortcut,
                capture_screenshot,
                show_main_window,
                list_capture_devices,
                pick_capture_source,
                cancel_capture_picker,
                get_capture_picker_context,
                capture_picker_ready,
                complete_capture_picker,
                get_capture_status,
                capture_controls_ready,
                capture_controls_action,
                start_capture,
                cancel_capture_start,
                pause_capture,
                resume_capture,
                set_capture_muted,
                set_capture_microphone,
                stop_capture,
                save_bytes,
                copy_image_to_clipboard,
                save_project_file,
                open_project_file,
                close_native_window
            ])
            .build(tauri::generate_context!())
            .expect("无法启动应用");
        app.run(|handle, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = &event {
                handle
                    .state::<CapturePicker>()
                    .cancel_window(handle, "main");
                if !handle.state::<Closing>().0.load(Ordering::SeqCst) {
                    api.prevent_exit();
                    let _ = handle.emit("native-close-requested", ());
                }
            }
            if matches!(event, tauri::RunEvent::Exit) {
                let state = handle.state::<MediaState>();
                handle.state::<crate::screenshot_shortcut::ShortcutManager>().shutdown();
                handle.state::<ControlsManager>().close(handle);
                handle.state::<ImageClipboard>().shutdown();
                state.capture_starts.cancel_all();
                state.speech.shutdown();
                state.jobs.shutdown();
                state.capture.lock().unwrap().abort();
            }
        });
    }
}
#[cfg(feature = "desktop")]
pub use desktop::run;
