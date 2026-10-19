pub mod capture;
#[cfg(any(target_os = "macos", test))]
pub mod capture_service;
#[cfg(any(feature = "desktop", test))]
pub mod capture_picker;
#[cfg(any(target_os = "windows", test))]
mod capture_windows;
pub mod engine;
pub mod export_files;
pub mod clip_filters;
pub mod chroma_key;
pub mod preview;
pub mod project_files;
mod media_metadata;
pub mod video_library;
pub mod mcp;
pub mod mcp_files;
pub mod asset_tools;
pub mod clip_animation;
pub mod audio_tools;
pub mod audio_tools_asr;
pub mod preview_tools;
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
#[cfg(test)]
mod recording_store_tests;
#[cfg(test)]
mod export_scaling_tests;

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
        mcp::{McpConfig, McpManager, McpRequest, McpStatus},
        video_library::{StoredVideos, VideoLibrary},
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
        video_library: VideoLibrary,
        asset_tools: crate::asset_tools::AssetTools,
        audio_tools: crate::audio_tools::AudioToolsManager,
        asr: crate::audio_tools_asr::AsrManager,
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

    fn require_mcp_window(window: &tauri::WebviewWindow) -> engine::Result<()> {
        let url = window.url().map_err(|_| "无法确认 MCP 请求来源。")?;
        crate::mcp_files::require_editor_origin(window.label(), url.scheme(), url.host_str(), url.port(), cfg!(debug_assertions))
    }

    #[tauri::command]
    pub async fn mcp_asset_tool(task_id: String, operation: String, args: Value, window: tauri::WebviewWindow, state: State<'_, MediaState>) -> engine::Result<Value> {
        require_mcp_window(&window)?;
        let state = state.inner().clone();
        blocking(move || state.asset_tools.execute(&state.store, &state.runtime()?, &task_id, &operation, &args)).await
    }
    #[tauri::command]
    pub fn mcp_asset_cancel(task_id: String, window: tauri::WebviewWindow, state: State<'_, MediaState>) -> engine::Result<bool> {
        require_mcp_window(&window)?;
        state.asset_tools.cancel(&task_id)
    }

    #[tauri::command]
    pub async fn begin_tool_preview(spec: Value, window: tauri::WebviewWindow, state: State<'_, MediaState>) -> engine::Result<MediaJob> {
        require_mcp_window(&window)?;
        let state = state.inner().clone();
        blocking(move || crate::preview_tools::begin(&state.store, &state.runtime()?, &state.jobs, &spec)).await
    }
    #[tauri::command]
    pub async fn tool_preview_result(id: String, window: tauri::WebviewWindow, state: State<'_, MediaState>) -> engine::Result<Value> {
        require_mcp_window(&window)?;
        let state = state.inner().clone();
        blocking(move || crate::preview_tools::result_payload(&state.store, &state.runtime()?, &state.jobs, &id)).await
    }
    #[tauri::command]
    pub async fn tool_preview_discard(id: String, window: tauri::WebviewWindow, state: State<'_, MediaState>) -> engine::Result<()> {
        require_mcp_window(&window)?;
        let state = state.inner().clone();
        blocking(move || crate::preview_tools::discard(&state.store, &state.jobs, &id)).await
    }
    #[tauri::command]
    pub async fn asr_status(window: tauri::WebviewWindow, state: State<'_, MediaState>) -> engine::Result<Value> {
        require_mcp_window(&window)?;
        let state = state.inner().clone();
        blocking(move || Ok(state.asr.status())).await
    }
    #[tauri::command]
    pub async fn asr_download(model_id: Option<String>, window: tauri::WebviewWindow, state: State<'_, MediaState>) -> engine::Result<crate::audio_tools_asr::AsrJob> {
        require_mcp_window(&window)?;
        let state = state.inner().clone();
        blocking(move || state.asr.begin_download(model_id.as_deref())).await
    }
    #[tauri::command]
    pub async fn asr_transcribe(spec: Value, window: tauri::WebviewWindow, state: State<'_, MediaState>) -> engine::Result<crate::audio_tools_asr::AsrJob> {
        require_mcp_window(&window)?;
        let state = state.inner().clone();
        blocking(move || state.asr.begin_transcribe(&state.runtime()?, &state.store, spec)).await
    }
    #[tauri::command]
    pub fn asr_job(id: String, window: tauri::WebviewWindow, state: State<'_, MediaState>) -> engine::Result<crate::audio_tools_asr::AsrJob> {
        require_mcp_window(&window)?;
        state.asr.get(&id)
    }
    #[tauri::command]
    pub fn asr_cancel(id: String, window: tauri::WebviewWindow, state: State<'_, MediaState>) -> engine::Result<()> {
        require_mcp_window(&window)?;
        state.asr.cancel(&id)
    }
    #[tauri::command]
    pub async fn audio_tool_begin(spec: Value, window: tauri::WebviewWindow, state: State<'_, MediaState>) -> engine::Result<crate::audio_tools::AudioToolJob> {
        require_mcp_window(&window)?;
        let state = state.inner().clone();
        blocking(move || state.audio_tools.begin(&state.runtime()?, &state.store, spec)).await
    }
    #[tauri::command]
    pub fn audio_tool_status(id: String, window: tauri::WebviewWindow, state: State<'_, MediaState>) -> engine::Result<crate::audio_tools::AudioToolJob> {
        require_mcp_window(&window)?;
        state.audio_tools.get(&id)
    }
    #[tauri::command]
    pub fn audio_tool_cancel(id: String, window: tauri::WebviewWindow, state: State<'_, MediaState>) -> engine::Result<()> {
        require_mcp_window(&window)?;
        state.audio_tools.cancel(&id)
    }
    #[tauri::command]
    pub fn audio_tool_accept(id: String, window: tauri::WebviewWindow, state: State<'_, MediaState>) -> engine::Result<()> {
        require_mcp_window(&window)?;
        state.audio_tools.accept(&id)
    }
    #[tauri::command]
    pub async fn audio_tool_discard(id: String, window: tauri::WebviewWindow, state: State<'_, MediaState>) -> engine::Result<()> {
        require_mcp_window(&window)?;
        let state = state.inner().clone();
        blocking(move || state.audio_tools.discard(&id)).await
    }

    #[tauri::command]
    pub fn mcp_get_config(window: tauri::WebviewWindow, state: State<'_, McpManager>) -> engine::Result<McpConfig> {
        require_mcp_window(&window)?;
        Ok(state.config())
    }
    #[tauri::command]
    pub fn mcp_get_status(window: tauri::WebviewWindow, state: State<'_, McpManager>) -> engine::Result<McpStatus> {
        require_mcp_window(&window)?;
        Ok(state.status())
    }
    #[tauri::command]
    pub async fn mcp_save_config(config: McpConfig, window: tauri::WebviewWindow, state: State<'_, McpManager>) -> engine::Result<McpConfig> {
        require_mcp_window(&window)?;
        let state = state.inner().clone();
        blocking(move || state.save_config(config)).await
    }
    #[tauri::command]
    pub async fn mcp_start(app: tauri::AppHandle, window: tauri::WebviewWindow, state: State<'_, McpManager>) -> engine::Result<McpStatus> {
        require_mcp_window(&window)?;
        let state = state.inner().clone();
        blocking(move || {
            let tools: Vec<Value> = serde_json::from_str(include_str!("../../src/mcp-tools.json"))
                .map_err(|_| "MCP 工具清单无法读取。")?;
            let request_manager = state.clone();
            let dispatch = Arc::new(move |request: McpRequest| {
                let handle = app.clone();
                let manager = request_manager.clone();
                // The HTTP runtime must never wait on a webview getter: application exit
                // joins that runtime on the main thread. Queue the entire UI operation.
                app.run_on_main_thread(move || {
                    // A stop or an earlier renderer replay may already have consumed it.
                    // Do not claim here; successful delivery is claimed by the renderer.
                    if !manager.pending().iter().any(|pending| pending.id == request.id) {
                        return;
                    }
                    let request_id = request.id.clone();
                    let result = (|| -> engine::Result<()> {
                        let window = handle.get_webview_window("main").ok_or("主窗口已关闭。")?;
                        require_mcp_window(&window)?;
                        window.emit("mcp-request", request).map_err(|error| format!("无法发送 MCP 编辑请求：{error}"))
                    })();
                    if let Err(error) = result {
                        // Only a failed delivery is completed here; completion requires
                        // a claim, and both operations reject stopped/expired requests.
                        if manager.claim(&request_id) {
                            manager.complete(&request_id, serde_json::json!({ "error": error }), true);
                        }
                    }
                }).map_err(|error| format!("无法排队 MCP 编辑请求：{error}"))
            });
            state.start(state.config(), tools, dispatch)
        }).await
    }
    #[tauri::command]
    pub async fn mcp_stop(window: tauri::WebviewWindow, state: State<'_, McpManager>) -> engine::Result<McpStatus> {
        require_mcp_window(&window)?;
        let state = state.inner().clone();
        blocking(move || Ok(state.stop())).await
    }
    #[tauri::command]
    pub fn mcp_pending(window: tauri::WebviewWindow, state: State<'_, McpManager>) -> engine::Result<Vec<McpRequest>> {
        require_mcp_window(&window)?;
        Ok(state.pending())
    }
    #[tauri::command]
    pub fn mcp_claim(id: String, window: tauri::WebviewWindow, state: State<'_, McpManager>) -> engine::Result<bool> {
        require_mcp_window(&window)?;
        Ok(state.claim(&id))
    }
    #[tauri::command]
    pub fn mcp_complete(id: String, result: Value, is_error: bool, window: tauri::WebviewWindow, state: State<'_, McpManager>) -> engine::Result<bool> {
        require_mcp_window(&window)?;
        Ok(state.complete(&id, result, is_error))
    }
    #[tauri::command]
    pub async fn mcp_import_media_paths(paths: Vec<String>, window: tauri::WebviewWindow, state: State<'_, MediaState>) -> engine::Result<Vec<Asset>> {
        require_mcp_window(&window)?;
        let state = state.inner().clone();
        blocking(move || crate::mcp_files::import_media_paths(&state.store, &state.runtime()?, &paths)).await
    }
    #[tauri::command]
    pub async fn mcp_save_project_file(bytes: Vec<u8>, token: Option<String>, path: Option<String>, overwrite: Option<bool>, window: tauri::WebviewWindow, media: State<'_, MediaState>, files: State<'_, ProjectFiles>) -> engine::Result<ProjectTarget> {
        require_mcp_window(&window)?;
        project_files::validate_project_size(bytes.len() as u64)?;
        let store = media.store.clone();
        let files = files.inner().clone();
        blocking(move || crate::mcp_files::save_project(&files, &store, &bytes, token.as_deref(), path.as_deref(), overwrite.unwrap_or(false))).await
    }
    #[tauri::command]
    pub async fn mcp_open_project_file(path: String, window: tauri::WebviewWindow, state: State<'_, ProjectFiles>) -> engine::Result<ProjectFile> {
        require_mcp_window(&window)?;
        let files = state.inner().clone();
        blocking(move || crate::mcp_files::open_project(&files, &path)).await
    }
    #[tauri::command]
    pub async fn mcp_begin_media_job(spec: Value, output_path: String, overwrite: Option<bool>, window: tauri::WebviewWindow, state: State<'_, MediaState>) -> engine::Result<MediaJob> {
        require_mcp_window(&window)?;
        let state = state.inner().clone();
        blocking(move || crate::mcp_files::begin_export(&state.store, &state.runtime()?, &state.jobs, &spec, &output_path, overwrite.unwrap_or(false))).await
    }

    #[tauri::command]
    pub fn get_runtime_status(state: State<'_, MediaState>) -> RuntimeStatus {
        Runtime::status(&state.runtime.lock().unwrap())
    }
    #[tauri::command]
    pub async fn list_stored_videos(
        window: tauri::WebviewWindow,
        state: State<'_, MediaState>,
    ) -> engine::Result<StoredVideos> {
        project_files::require_main_window(window.label())?;
        let state = state.inner().clone();
        blocking(move || {
            state.video_library.list(&state.store.recording_store()?, &state.runtime()?)
        }).await
    }
    #[tauri::command]
    pub async fn open_media_library_directory(
        window: tauri::WebviewWindow,
        state: State<'_, MediaState>,
    ) -> engine::Result<()> {
        project_files::require_main_window(window.label())?;
        let store = state.store.clone();
        blocking(move || {
            crate::export_files::open_media_library_directory(&store.recording_store()?)
        }).await
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
                    let asset = state.store.import(&runtime, &path, None)?;
                    crate::export_files::remember_asset_source(&state.store, &asset, &path)?;
                    Ok(asset)
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
            if state.store.is_internal_path(&canonical_parent) {
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
    pub async fn reveal_media_job_output(
        window: tauri::Window,
        id: String,
        state: State<'_, MediaState>,
    ) -> engine::Result<()> {
        project_files::require_main_window(window.label())?;
        let jobs = state.jobs.list();
        blocking(move || crate::export_files::reveal_job_output(&jobs, &id)).await
    }
    #[tauri::command]
    pub async fn reveal_media_asset(
        window: tauri::Window,
        asset: Value,
        state: State<'_, MediaState>,
    ) -> engine::Result<()> {
        project_files::require_main_window(window.label())?;
        let store = state.store.clone();
        blocking(move || crate::export_files::reveal_media_asset(&store, &asset)).await
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
    pub async fn repair_speech_model(
        model_id: String,
        state: State<'_, MediaState>,
    ) -> engine::Result<SpeechStatus> {
        let speech = state.speech.clone();
        blocking(move || speech.repair_model(&model_id)).await
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
    pub fn get_desktop_platform(window: tauri::WebviewWindow) -> engine::Result<String> {
        capture_picker::require_main(&window)?;
        Ok(std::env::consts::OS.to_string())
    }
    #[tauri::command]
    pub fn show_main_window(window: tauri::WebviewWindow) -> engine::Result<()> {
        capture_picker::require_main(&window)?;
        capture_picker::restore_main_window(&window)
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
            .manage(ImageClipboard::default())
            .manage(ControlsManager::default())
            .setup(|app| {
                app.manage(crate::screenshot_shortcut::ShortcutManager::new(app.handle().clone()));
                let data = app.path().app_data_dir()?;
                fs::create_dir_all(&data)?;
                app.manage(ProjectFiles::persistent(data.join("project-file-targets.json")).map_err(std::io::Error::other)?);
                app.manage(McpManager::new(data.join("mcp-settings.json")).map_err(std::io::Error::other)?);
                let resource = app.path().resource_dir()?;
                let settings = data.join("media-engine-path.txt");
                let selected = fs::read_to_string(&settings).ok().map(PathBuf::from);
                let store = MediaStore::new(&data).map_err(std::io::Error::other)?;
                let runtime = Runtime::discover(Some(&resource), selected.as_deref());
                app.manage(MediaState {
                    runtime: Arc::new(Mutex::new(runtime)),
                    store,
                    jobs: JobManager::default(),
                    video_library: VideoLibrary::new(data.join("stored-recording-index.json")),
                    asset_tools: crate::asset_tools::AssetTools::new(&data).map_err(std::io::Error::other)?,
                    audio_tools: crate::audio_tools::AudioToolsManager::default(),
                    asr: crate::audio_tools_asr::AsrManager::new(&data, Some(&resource)).map_err(std::io::Error::other)?,
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
                mcp_get_config,
                mcp_get_status,
                mcp_save_config,
                mcp_start,
                mcp_stop,
                mcp_pending,
                mcp_claim,
                mcp_complete,
                mcp_import_media_paths,
                mcp_save_project_file,
                mcp_open_project_file,
                mcp_begin_media_job,
                mcp_asset_tool,
                mcp_asset_cancel,
                begin_tool_preview,
                tool_preview_result,
                tool_preview_discard,
                asr_status,
                asr_download,
                asr_transcribe,
                asr_job,
                asr_cancel,
                audio_tool_begin,
                audio_tool_status,
                audio_tool_cancel,
                audio_tool_accept,
                audio_tool_discard,
                get_runtime_status,
                list_stored_videos,
                open_media_library_directory,
                select_runtime,
                pick_media_assets,
                import_blob_asset,
                create_media_preview,
                begin_media_job,
                get_media_jobs,
                cancel_media_job,
                reveal_media_job_output,
                reveal_media_asset,
                get_speech_status,
                begin_speech_model_download,
                cancel_speech_model_download,
                repair_speech_model,
                begin_speech_job,
                get_speech_job,
                cancel_speech_job,
                discard_speech_job,
                accept_speech_jobs,
                configure_screenshot_shortcut,
                get_desktop_platform,
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
                handle.state::<McpManager>().stop();
                handle.state::<crate::screenshot_shortcut::ShortcutManager>().shutdown();
                handle.state::<ControlsManager>().close(handle);
                handle.state::<ImageClipboard>().shutdown();
                state.capture_starts.cancel_all();
                state.speech.shutdown();
                state.jobs.shutdown();
                state.asset_tools.shutdown();
                state.audio_tools.shutdown();
                state.asr.shutdown();
                state.capture.lock().unwrap().abort();
            }
        });
    }
}
#[cfg(feature = "desktop")]
pub use desktop::run;

#[cfg(test)]
mod mcp_dispatch_thread_tests {
    use crate::mcp::{McpManager, McpRequest};
    use serde_json::json;
    use std::{
        io::{Read, Write},
        net::TcpStream,
        sync::{atomic::{AtomicUsize, Ordering}, mpsc, Arc},
        thread,
        time::{Duration, Instant},
    };

    #[test]
    fn stop_does_not_wait_for_queued_ui_work_and_late_delivery_is_discarded() {
        let directory = tempfile::tempdir().unwrap();
        let manager = McpManager::new(directory.path().join("mcp.json")).unwrap();
        let mut config = manager.config();
        config.port = 0;
        let tools = vec![json!({"name":"open_media_echo","inputSchema":{"type":"object"}})];
        let (queue, ui) = mpsc::channel::<Box<dyn FnOnce() + Send>>();
        let delivered = Arc::new(AtomicUsize::new(0));
        let events = delivered.clone();
        let pending = manager.clone();
        let status = manager.start(config.clone(), tools.clone(), Arc::new(move |request: McpRequest| {
            let manager = pending.clone();
            let events = events.clone();
            // Model a main-thread queue that cannot run until shutdown has returned.
            queue.send(Box::new(move || {
                if manager.pending().iter().any(|item| item.id == request.id) {
                    events.fetch_add(1, Ordering::SeqCst);
                }
            })).map_err(|error| error.to_string())
        })).unwrap();
        let token = config.token.clone();
        let client = thread::spawn(move || {
            let body = json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"open_media_echo","arguments":{}}}).to_string();
            let mut stream = TcpStream::connect(("127.0.0.1", status.port)).unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            write!(stream, "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", status.port, body.len()).unwrap();
            let mut response = Vec::new();
            if let Err(error) = stream.read_to_end(&mut response) {
                assert!(matches!(error.kind(), std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted));
            }
        });
        let late_ui_work = ui.recv_timeout(Duration::from_secs(3)).unwrap();
        assert_eq!(manager.pending().len(), 1);
        let request_id = manager.pending()[0].id.clone();
        let began = Instant::now();
        manager.stop();
        assert!(began.elapsed() < Duration::from_secs(2), "Shutdown waited for the undrained UI queue");
        assert!(manager.pending().is_empty());
        assert!(!manager.claim(&request_id));
        client.join().unwrap();
        // Even restarting the service cannot make a queued request from its previous
        // lifetime eligible for dispatch into the editor.
        manager.start(config, tools, Arc::new(|_| Ok(()))).unwrap();
        late_ui_work();
        assert_eq!(delivered.load(Ordering::SeqCst), 0);
        manager.stop();
    }
}
