pub mod capture;
#[cfg(any(target_os = "windows", test))]
mod capture_windows;
pub mod engine;
pub mod preview;
#[cfg(test)]
mod tests;

#[cfg(feature = "desktop")]
mod desktop {
    use crate::{
        capture::{
            self, CaptureDevice, CaptureManager, CaptureOptions, CaptureStartCancellation,
            CaptureStatus,
        },
        engine::{self, Asset, JobManager, MediaJob, MediaStore, Runtime, RuntimeStatus},
        preview::{self, PreviewResult},
    };
    use serde::Serialize;
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
    pub async fn get_capture_status(state: State<'_, MediaState>) -> engine::Result<CaptureStatus> {
        let state = state.inner().clone();
        blocking(move || Ok(state.capture.lock().unwrap().status())).await
    }
    #[tauri::command]
    pub async fn start_capture(
        options: CaptureOptions,
        state: State<'_, MediaState>,
    ) -> engine::Result<CaptureStatus> {
        let state = state.inner().clone();
        let request_id = options.request_id.clone().unwrap_or_else(engine::new_id);
        let cancelled = state.capture_starts.token(&request_id)?;
        blocking(move || {
            let result = (|| {
                state.capture.lock().unwrap().start_cancellable(
                    &state.runtime()?,
                    options,
                    &cancelled,
                )
            })();
            state.capture_starts.complete(&request_id);
            result
        })
        .await
    }
    #[tauri::command]
    pub fn cancel_capture_start(
        request_id: String,
        state: State<'_, MediaState>,
    ) -> engine::Result<()> {
        state.capture_starts.cancel(&request_id)
    }
    #[tauri::command]
    pub async fn pause_capture(state: State<'_, MediaState>) -> engine::Result<CaptureStatus> {
        let state = state.inner().clone();
        blocking(move || state.capture.lock().unwrap().pause()).await
    }
    #[tauri::command]
    pub async fn resume_capture(state: State<'_, MediaState>) -> engine::Result<CaptureStatus> {
        let state = state.inner().clone();
        blocking(move || state.capture.lock().unwrap().resume()).await
    }
    #[tauri::command]
    pub async fn stop_capture(state: State<'_, MediaState>) -> engine::Result<Option<Asset>> {
        let state = state.inner().clone();
        blocking(move || state.capture.lock().unwrap().stop(&state.store)).await
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
    #[derive(Serialize)]
    pub struct ProjectFile {
        name: String,
        bytes: Vec<u8>,
    }
    #[tauri::command]
    pub async fn open_project_file(app: tauri::AppHandle) -> engine::Result<Option<ProjectFile>> {
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
            let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
            if meta.len() > 1024 * 1024 * 1024 {
                return Err("项目文件超过 1 GB 导入上限。".into());
            }
            Ok(Some(ProjectFile {
                name: path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into(),
                bytes: fs::read(path).map_err(|e| e.to_string())?,
            }))
        })
        .await
    }
    #[tauri::command]
    pub fn close_native_window(
        app: tauri::AppHandle,
        state: State<'_, Closing>,
    ) -> engine::Result<()> {
        state.0.store(true, Ordering::SeqCst);
        if let Some(window) = app.get_webview_window("main") {
            window.close().map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn run() {
        let app = tauri::Builder::default()
            .plugin(tauri_plugin_dialog::init())
            .manage(Closing::default())
            .setup(|app| {
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
                    capture: Arc::new(Mutex::new(CaptureManager::with_resource(&resource))),
                    capture_starts: Arc::new(CaptureStartCancellation::default()),
                    resource,
                    settings,
                });
                Ok(())
            })
            .on_window_event(|window, event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    let closing = window.state::<Closing>();
                    if !closing.0.load(Ordering::SeqCst) {
                        api.prevent_close();
                        let _ = window.emit("native-close-requested", ());
                    }
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
                list_capture_devices,
                get_capture_status,
                start_capture,
                cancel_capture_start,
                pause_capture,
                resume_capture,
                stop_capture,
                save_bytes,
                open_project_file,
                close_native_window
            ])
            .build(tauri::generate_context!())
            .expect("无法启动应用");
        app.run(|handle, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = &event {
                if !handle.state::<Closing>().0.load(Ordering::SeqCst) {
                    api.prevent_exit();
                    let _ = handle.emit("native-close-requested", ());
                }
            }
            if matches!(event, tauri::RunEvent::Exit) {
                let state = handle.state::<MediaState>();
                state.capture_starts.cancel_all();
                state.jobs.shutdown();
                state.capture.lock().unwrap().abort();
            }
        });
    }
}
#[cfg(feature = "desktop")]
pub use desktop::run;
