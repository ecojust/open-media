use crate::{
    capture::{CaptureBounds, CaptureDevice, OutputSize, Region},
    engine::Result,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PickerMode {
    #[default]
    Region,
    Window,
    Screen,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickerPreferences {
    #[serde(default)]
    pub purpose: Option<String>,
    #[serde(default)]
    pub mode: PickerMode,
    pub source_id: Option<String>,
    pub output_size: Option<OutputSize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub microphone: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio_device: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickerSelection {
    pub source_id: String,
    pub region: Option<Region>,
    pub output_size: Option<OutputSize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub microphone: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio_device: Option<String>,
    pub source_name: Option<String>,
    pub source_width: Option<u32>,
    pub source_height: Option<u32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickerDisplay {
    pub id: String,
    pub name: String,
    pub logical_width: f64,
    pub logical_height: f64,
    pub pixel_width: u32,
    pub pixel_height: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickerTarget {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub rect: CaptureBounds,
    pub source_width: u32,
    pub source_height: u32,
}

#[derive(Clone, Debug, Serialize)]
pub struct PickerAudioDevice {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickerContext {
    pub request_id: String,
    pub display_id: String,
    pub display: PickerDisplay,
    pub targets: Vec<PickerTarget>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_devices: Option<Vec<PickerAudioDevice>>,
    pub preferences: PickerPreferences,
}

fn normalized_preferences(mut preferences: PickerPreferences) -> PickerPreferences {
    preferences.audio_device = if preferences.purpose.as_deref() == Some("screenshot") {
        None
    } else {
        preferences.audio_device.filter(|id| !id.is_empty())
    };
    preferences.microphone = if preferences.purpose.as_deref() == Some("screenshot") {
        None
    } else {
        Some(preferences.microphone.unwrap_or(true))
    };
    preferences
}

fn apply_audio_preference(
    mut selection: PickerSelection,
    preferences: &PickerPreferences,
) -> PickerSelection {
    selection.audio_device = if preferences.purpose.as_deref() == Some("screenshot") {
        None
    } else {
        // An empty selection explicitly returns to the default device; an
        // absent field retains the user's previous input choice.
        selection
            .audio_device
            .or_else(|| preferences.audio_device.clone())
            .filter(|id| !id.is_empty())
    };
    selection.microphone = if preferences.purpose.as_deref() == Some("screenshot") {
        None
    } else {
        Some(
            selection
                .microphone
                .or(preferences.microphone)
                .unwrap_or(true),
        )
    };
    selection
}

fn valid_request_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn source_geometry(source: &CaptureDevice) -> Result<(&CaptureBounds, u32, u32)> {
    let bounds = source.bounds.as_ref().ok_or("录制来源没有有效的位置。")?;
    let width = source.width.ok_or("录制来源没有有效的尺寸。")?;
    let height = source.height.ok_or("录制来源没有有效的尺寸。")?;
    if ![bounds.x, bounds.y, bounds.width, bounds.height]
        .iter()
        .all(|value| value.is_finite())
        || bounds.width <= 0.0
        || bounds.height <= 0.0
        || width < 16
        || height < 16
    {
        return Err("录制来源的位置或尺寸无效，请刷新后重新选择。".into());
    }
    Ok((bounds, width, height))
}

fn intersects(left: &CaptureBounds, right: &CaptureBounds) -> bool {
    left.x < right.x + right.width
        && right.x < left.x + left.width
        && left.y < right.y + right.height
        && right.y < left.y + left.height
}

/// Native display bounds are desktop points on macOS and physical pixels on Windows.
fn make_context(
    request_id: &str,
    display: &CaptureDevice,
    sources: &[CaptureDevice],
    preferences: &PickerPreferences,
    bounds_are_points: bool,
) -> Result<PickerContext> {
    let (bounds, pixel_width, pixel_height) = source_geometry(display)?;
    if display.kind != "screen" {
        return Err("区域选择器需要有效的显示器。".into());
    }
    let coordinate_scale = if bounds_are_points {
        1.0
    } else {
        display.scale_factor.unwrap_or(1.0)
    };
    if !coordinate_scale.is_finite() || coordinate_scale <= 0.0 {
        return Err("显示器缩放比例无效。".into());
    }
    let mut targets = Vec::new();
    for source in sources {
        if source.id != display.id && source.kind != "window" {
            continue;
        }
        let Ok((source_bounds, source_width, source_height)) = source_geometry(source) else {
            continue;
        };
        if !intersects(bounds, source_bounds) {
            continue;
        }
        targets.push(PickerTarget {
            id: source.id.clone(),
            name: source.name.clone(),
            kind: source.kind.clone(),
            rect: CaptureBounds {
                x: (source_bounds.x - bounds.x) / coordinate_scale,
                y: (source_bounds.y - bounds.y) / coordinate_scale,
                width: source_bounds.width / coordinate_scale,
                height: source_bounds.height / coordinate_scale,
            },
            source_width,
            source_height,
        });
    }
    Ok(PickerContext {
        request_id: request_id.into(),
        display_id: display.id.clone(),
        display: PickerDisplay {
            id: display.id.clone(),
            name: display.name.clone(),
            logical_width: bounds.width / coordinate_scale,
            logical_height: bounds.height / coordinate_scale,
            pixel_width,
            pixel_height,
        },
        targets,
        audio_devices: if preferences.purpose.as_deref() == Some("screenshot") {
            None
        } else {
            Some(
                sources
                    .iter()
                    .filter(|source| source.kind == "audio")
                    .map(|source| PickerAudioDevice {
                        id: source.id.clone(),
                        name: source.name.clone(),
                    })
                    .collect(),
            )
        },
        preferences: normalized_preferences(preferences.clone()),
    })
}

fn validate_selection(
    mut selection: PickerSelection,
    display: &CaptureDevice,
    sources: &[CaptureDevice],
) -> Result<PickerSelection> {
    if selection.microphone == Some(true) {
        if let Some(id) = selection
            .audio_device
            .as_deref()
            .filter(|id| !id.is_empty())
        {
            if !sources
                .iter()
                .any(|source| source.kind == "audio" && source.id == id)
            {
                return Err("所选麦克风已断开，请重新选择或关闭麦克风录制。".into());
            }
        }
    }
    let source = sources
        .iter()
        .find(|source| source.id == selection.source_id)
        .ok_or("录制来源已不可用，请重新选择。")?;
    let (bounds, width, height) = source_geometry(source)?;
    let (display_bounds, _, _) = source_geometry(display)?;
    if (source.kind == "screen" && source.id != display.id)
        || !["window", "screen"].contains(&source.kind.as_str())
        || !intersects(bounds, display_bounds)
    {
        return Err("请选择当前显示器上的窗口或区域。".into());
    }
    if let Some(region) = selection.region.as_ref() {
        if source.kind != "screen"
            || region.x < 0
            || region.y < 0
            || region.width < 16
            || region.height < 16
            || u64::from(region.x as u32) + u64::from(region.width) > u64::from(width)
            || u64::from(region.y as u32) + u64::from(region.height) > u64::from(height)
        {
            return Err("录制区域超出当前屏幕，或小于 16 × 16 像素。".into());
        }
    }
    if let Some(output) = selection.output_size.as_ref() {
        if !(16..=7680).contains(&output.width)
            || !(16..=4320).contains(&output.height)
            || output.width % 2 != 0
            || output.height % 2 != 0
        {
            return Err("输出尺寸需要是 16 至 7680 × 4320 范围内的偶数。".into());
        }
    }
    selection.source_name = Some(source.name.clone());
    selection.source_width = Some(width);
    selection.source_height = Some(height);
    Ok(selection)
}

#[cfg(feature = "desktop")]
mod desktop {
    use super::*;
    use crate::{capture, engine::Runtime};
    use std::{
        collections::{HashMap, HashSet},
        path::PathBuf,
        sync::{
            atomic::{AtomicBool, Ordering},
            mpsc, Arc, Mutex,
        },
        time::Duration,
    };
    use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

    type Completion = Result<Option<PickerSelection>>;

    struct PickerWindow {
        display: CaptureDevice,
        context: PickerContext,
        ready: bool,
        positioned: bool,
    }

    struct Session {
        request_id: String,
        preferences: PickerPreferences,
        sources: Vec<CaptureDevice>,
        windows: HashMap<String, PickerWindow>,
        cancelled: Arc<AtomicBool>,
        sender: mpsc::Sender<Completion>,
        shown: bool,
    }

    #[derive(Default)]
    struct PickerInner {
        active: Option<Session>,
        cancelled: HashSet<String>,
    }

    #[derive(Clone, Default)]
    pub struct CapturePicker {
        inner: Arc<Mutex<PickerInner>>,
    }

    impl CapturePicker {
        pub fn start(
            &self,
            app: &tauri::AppHandle,
            request_id: String,
            preferences: PickerPreferences,
            runtime: Runtime,
            resource: PathBuf,
        ) -> Result<mpsc::Receiver<Completion>> {
            if !valid_request_id(&request_id) {
                return Err("录制选择请求编号无效。".into());
            }
            let (sender, receiver) = mpsc::channel();
            let cancelled = Arc::new(AtomicBool::new(false));
            {
                let mut inner = self.inner.lock().map_err(|_| "录制选择状态不可用。")?;
                if inner.cancelled.remove(&request_id) {
                    let _ = sender.send(Ok(None));
                    return Ok(receiver);
                }
                if inner.active.is_some() {
                    return Err("已有录制选择正在进行，请先完成或取消。".into());
                }
                inner.active = Some(Session {
                    request_id: request_id.clone(),
                    preferences: normalized_preferences(preferences),
                    sources: vec![],
                    windows: HashMap::new(),
                    cancelled: cancelled.clone(),
                    sender,
                    shown: false,
                });
            }
            let picker = self.clone();
            let app = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let result = capture::list_devices_with_resource_cancellable(
                    &runtime, &resource, true, &cancelled,
                );
                if cancelled.load(Ordering::SeqCst) {
                    return;
                }
                match result {
                    Ok(sources) => {
                        #[cfg(target_os = "macos")]
                        {
                            let main_app = app.clone();
                            let main_picker = picker.clone();
                            let main_id = request_id.clone();
                            if let Err(error) = app.run_on_main_thread(move || {
                                if let Err(error) =
                                    main_picker.create_windows(&main_app, &main_id, sources)
                                {
                                    main_picker.finish(&main_app, &main_id, Err(error));
                                }
                            }) {
                                picker.finish(&app, &request_id, Err(error.to_string()));
                            }
                        }
                        // Window creation must not run inside the Windows event callback.
                        #[cfg(not(target_os = "macos"))]
                        if let Err(error) = picker.create_windows(&app, &request_id, sources) {
                            picker.finish(&app, &request_id, Err(error));
                        }
                    }
                    Err(error) => picker.finish(&app, &request_id, Err(error)),
                }
            });
            Ok(receiver)
        }

        fn create_windows(
            &self,
            app: &tauri::AppHandle,
            request_id: &str,
            sources: Vec<CaptureDevice>,
        ) -> Result<()> {
            let displays: Vec<_> = sources
                .iter()
                .filter(|source| source.kind == "screen")
                .cloned()
                .collect();
            if displays.is_empty() {
                return Err("没有可选择的屏幕，请检查屏幕录制权限后重试。".into());
            }
            let prepared = {
                let mut inner = self.inner.lock().map_err(|_| "录制选择状态不可用。")?;
                let Some(session) = inner.active.as_mut().filter(|s| s.request_id == request_id)
                else {
                    return Ok(());
                };
                if session.cancelled.load(Ordering::SeqCst) {
                    return Ok(());
                }
                session.sources = sources;
                let mut prepared = Vec::new();
                for (index, display) in displays.into_iter().enumerate() {
                    let context = make_context(
                        request_id,
                        &display,
                        &session.sources,
                        &session.preferences,
                        cfg!(target_os = "macos"),
                    )?;
                    let label = format!("capture-picker-{}-{index}", crate::engine::new_id());
                    // Register every identity before any page can issue an IPC request.
                    session.windows.insert(
                        label.clone(),
                        PickerWindow {
                            display: display.clone(),
                            context: context.clone(),
                            ready: false,
                            positioned: false,
                        },
                    );
                    prepared.push((label, display, context));
                }
                prepared
            };
            for (label, display, context) in prepared {
                if !self.is_active(request_id) {
                    return Ok(());
                }
                let bounds = display.bounds.as_ref().ok_or("显示器位置不可用。")?;
                let mut url = tauri::Url::parse("http://localhost/index.html")
                    .map_err(|error| error.to_string())?;
                url.query_pairs_mut()
                    .append_pair("capture-picker", request_id)
                    .append_pair("display", &display.id);
                let path = format!("index.html?{}", url.query().unwrap_or_default());
                let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(path.into()))
                    .title("选择录制范围")
                    .inner_size(
                        context.display.logical_width,
                        context.display.logical_height,
                    )
                    .decorations(false)
                    .transparent(true)
                    .background_color(tauri::webview::Color(0, 0, 0, 0))
                    .shadow(false)
                    .resizable(false)
                    .maximizable(false)
                    .minimizable(false)
                    .always_on_top(true)
                    .visible_on_all_workspaces(true)
                    .content_protected(true)
                    .skip_taskbar(true)
                    .accept_first_mouse(true)
                    .focused(false)
                    .visible(false)
                    .build()
                    .map_err(|error| format!("无法打开录制范围选择器：{error}"))?;
                // A cancellation may arrive while native window creation is in progress.
                if !self.is_active(request_id) {
                    let _ = window.destroy();
                    return Ok(());
                }
                #[cfg(target_os = "macos")]
                {
                    window
                        .set_position(tauri::LogicalPosition::new(bounds.x, bounds.y))
                        .map_err(|error| error.to_string())?;
                    window
                        .set_size(tauri::LogicalSize::new(bounds.width, bounds.height))
                        .map_err(|error| error.to_string())?;
                    set_selection_window_level(&window)?;
                }
                #[cfg(not(target_os = "macos"))]
                {
                    window
                        .set_position(tauri::PhysicalPosition::new(
                            bounds.x as i32,
                            bounds.y as i32,
                        ))
                        .map_err(|error| error.to_string())?;
                    window
                        .set_size(tauri::PhysicalSize::new(
                            bounds.width as u32,
                            bounds.height as u32,
                        ))
                        .map_err(|error| error.to_string())?;
                }
                self.update_window_readiness(app, request_id, &label, false, true)?;
            }
            let picker = self.clone();
            let app = app.clone();
            let request_id = request_id.to_string();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(20));
                let not_ready = picker.inner.lock().ok().is_some_and(|inner| {
                    inner
                        .active
                        .as_ref()
                        .is_some_and(|session| session.request_id == request_id && !session.shown)
                });
                if not_ready {
                    picker.finish(
                        &app,
                        &request_id,
                        Err("录制范围选择器加载超时，请重试。".into()),
                    );
                }
            });
            Ok(())
        }

        fn is_active(&self, request_id: &str) -> bool {
            self.inner.lock().ok().is_some_and(|inner| {
                inner.active.as_ref().is_some_and(|session| {
                    session.request_id == request_id && !session.cancelled.load(Ordering::SeqCst)
                })
            })
        }

        pub fn context(&self, request_id: &str, window_label: &str) -> Result<PickerContext> {
            let inner = self.inner.lock().map_err(|_| "录制选择状态不可用。")?;
            let session = inner
                .active
                .as_ref()
                .filter(|session| session.request_id == request_id)
                .ok_or("此录制选择已结束。")?;
            session
                .windows
                .get(window_label)
                .map(|window| window.context.clone())
                .ok_or_else(|| "当前窗口没有此录制选择的访问权限。".into())
        }

        pub fn ready(
            &self,
            app: &tauri::AppHandle,
            request_id: &str,
            window_label: &str,
        ) -> Result<()> {
            self.update_window_readiness(app, request_id, window_label, true, false)
        }

        fn update_window_readiness(
            &self,
            app: &tauri::AppHandle,
            request_id: &str,
            window_label: &str,
            page_ready: bool,
            positioned: bool,
        ) -> Result<()> {
            let show = {
                let mut inner = self.inner.lock().map_err(|_| "录制选择状态不可用。")?;
                let session = inner
                    .active
                    .as_mut()
                    .filter(|session| session.request_id == request_id)
                    .ok_or("此录制选择已结束。")?;
                let window = session
                    .windows
                    .get_mut(window_label)
                    .ok_or("当前窗口没有此录制选择的访问权限。")?;
                window.ready |= page_ready;
                window.positioned |= positioned;
                if session.shown
                    || session
                        .windows
                        .values()
                        .any(|window| !window.ready || !window.positioned)
                {
                    false
                } else {
                    session.shown = true;
                    true
                }
            };
            if show {
                let app = app.clone();
                let picker = self.clone();
                let request_id = request_id.to_string();
                let dispatch = app.clone();
                dispatch
                    .run_on_main_thread(move || {
                        if let Err(error) = picker.show_windows(&app, &request_id) {
                            picker.finish(&app, &request_id, Err(error));
                        }
                    })
                    .map_err(|error| error.to_string())?;
            }
            Ok(())
        }

        fn show_windows(&self, app: &tauri::AppHandle, request_id: &str) -> Result<()> {
            let labels = {
                let inner = self.inner.lock().map_err(|_| "录制选择状态不可用。")?;
                let Some(session) = inner.active.as_ref().filter(|s| s.request_id == request_id)
                else {
                    return Ok(());
                };
                session.windows.keys().cloned().collect::<Vec<_>>()
            };
            if let Some(main) = app.get_webview_window("main") {
                main.hide().map_err(|error| error.to_string())?;
            }
            for label in &labels {
                app.get_webview_window(label)
                    .ok_or("录制选择窗口已关闭。")?
                    .show()
                    .map_err(|error| error.to_string())?;
            }
            if let Some(window) = labels
                .first()
                .and_then(|label| app.get_webview_window(label))
            {
                window.set_focus().map_err(|error| error.to_string())?;
            }
            Ok(())
        }

        pub fn complete(
            &self,
            app: &tauri::AppHandle,
            request_id: &str,
            window_label: &str,
            selection: Option<PickerSelection>,
        ) -> Result<()> {
            let selection = {
                let inner = self.inner.lock().map_err(|_| "录制选择状态不可用。")?;
                let session = inner
                    .active
                    .as_ref()
                    .filter(|session| session.request_id == request_id)
                    .ok_or("此录制选择已结束。")?;
                let window = session
                    .windows
                    .get(window_label)
                    .ok_or("当前窗口没有此录制选择的访问权限。")?;
                selection
                    .map(|selection| {
                        validate_selection(
                            apply_audio_preference(selection, &session.preferences),
                            &window.display,
                            &session.sources,
                        )
                    })
                    .transpose()?
            };
            self.finish(app, request_id, Ok(selection));
            Ok(())
        }

        pub fn cancel(&self, app: &tauri::AppHandle, request_id: &str) -> Result<()> {
            if !valid_request_id(request_id) {
                return Err("录制选择请求编号无效。".into());
            }
            {
                let mut inner = self.inner.lock().map_err(|_| "录制选择状态不可用。")?;
                if inner
                    .active
                    .as_ref()
                    .is_none_or(|session| session.request_id != request_id)
                {
                    if inner.cancelled.len() >= 256 {
                        inner.cancelled.clear();
                    }
                    inner.cancelled.insert(request_id.into());
                    return Ok(());
                }
            }
            self.finish(app, request_id, Ok(None));
            Ok(())
        }

        pub fn cancel_window(&self, app: &tauri::AppHandle, window_label: &str) {
            let request_id = self.inner.lock().ok().and_then(|inner| {
                inner.active.as_ref().and_then(|session| {
                    (window_label == "main" || session.windows.contains_key(window_label))
                        .then(|| session.request_id.clone())
                })
            });
            if let Some(request_id) = request_id {
                self.finish(app, &request_id, Ok(None));
            }
        }

        fn finish(&self, app: &tauri::AppHandle, request_id: &str, result: Completion) {
            let session = {
                let Ok(mut inner) = self.inner.lock() else {
                    return;
                };
                if inner
                    .active
                    .as_ref()
                    .is_none_or(|session| session.request_id != request_id)
                {
                    return;
                }
                inner.active.take()
            };
            let Some(session) = session else { return };
            session.cancelled.store(true, Ordering::SeqCst);
            let restore_focus = !matches!(result, Ok(Some(_)));
            let keep_hidden =
                !restore_focus && session.preferences.purpose.as_deref() == Some("screenshot");
            let dispatch = app.clone();
            let app = app.clone();
            let sender = session.sender.clone();
            if let Err(error) = dispatch.run_on_main_thread(move || {
                let mut cleanup_error = None;
                for label in session.windows.keys() {
                    if let Some(window) = app.get_webview_window(label) {
                        if let Err(error) = window.destroy() {
                            let _ = window.hide();
                            cleanup_error = Some(format!("无法关闭录制选择器：{error}"));
                        }
                    }
                }
                if let Some(main) = app.get_webview_window("main") {
                    // Keep the application out of the image until the PNG has been captured.
                    if !keep_hidden || cleanup_error.is_some() {
                        if restore_focus || keep_hidden {
                            let _ = main.show();
                            let _ = main.set_focus();
                        } else if let Err(error) = restore_behind_other_windows(&main) {
                            cleanup_error = Some(error);
                            let _ = main.show();
                            let _ = main.set_focus();
                        }
                    }
                }
                // Resolve only after every overlay is gone, before capture can start.
                let _ = session.sender.send(match (result, cleanup_error) {
                    (Ok(Some(_)), Some(error)) => Err(error),
                    (result, _) => result,
                });
            }) {
                let _ = sender.send(Err(format!("无法关闭录制选择器：{error}")));
            }
        }
    }

    pub fn require_main(window: &WebviewWindow) -> Result<()> {
        if window.label() == "main" {
            Ok(())
        } else {
            Err("请从主窗口开始或取消录制选择。".into())
        }
    }

    #[cfg(target_os = "windows")]
    fn restore_behind_other_windows(window: &WebviewWindow) -> Result<()> {
        use std::ffi::c_void;
        #[link(name = "user32")]
        unsafe extern "system" {
            fn SetWindowPos(
                window: *mut c_void,
                after: *mut c_void,
                x: i32,
                y: i32,
                width: i32,
                height: i32,
                flags: u32,
            ) -> i32;
        }
        let native = window.hwnd().map_err(|error| error.to_string())?;
        // Show at the bottom of the normal window stack without activating it.
        let succeeded = unsafe { SetWindowPos(native.0, 1_usize as *mut c_void, 0, 0, 0, 0, 0x53) };
        if succeeded == 0 {
            return Err("无法将主窗口恢复到后台，请重新选择录制范围。".into());
        }
        Ok(())
    }

    #[cfg(target_os = "macos")]
    fn restore_behind_other_windows(window: &WebviewWindow) -> Result<()> {
        use std::ffi::{c_char, c_void};
        #[link(name = "objc")]
        unsafe extern "C" {
            fn sel_registerName(name: *const c_char) -> *mut c_void;
            #[link_name = "objc_msgSend"]
            fn send_message();
        }
        let native = window.ns_window().map_err(|error| error.to_string())?;
        // Ordering to the back restores the window without making it key.
        unsafe {
            let selector = sel_registerName(c"orderBack:".as_ptr());
            let send: unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void) =
                std::mem::transmute(send_message as unsafe extern "C" fn());
            send(native, selector, std::ptr::null_mut());
        }
        Ok(())
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    fn restore_behind_other_windows(_window: &WebviewWindow) -> Result<()> {
        Err("当前系统不支持桌面交互选区。".into())
    }

    #[cfg(target_os = "macos")]
    unsafe fn send_window_message(
        window: *mut std::ffi::c_void,
        name: &std::ffi::CStr,
        value: isize,
    ) {
        use std::ffi::{c_char, c_void};
        #[link(name = "objc")]
        unsafe extern "C" {
            fn sel_registerName(name: *const c_char) -> *mut c_void;
            #[link_name = "objc_msgSend"]
            fn send_message();
        }
        let selector = sel_registerName(name.as_ptr());
        let send: unsafe extern "C" fn(*mut c_void, *mut c_void, isize) =
            std::mem::transmute(send_message as unsafe extern "C" fn());
        send(window, selector, value);
    }

    #[cfg(target_os = "macos")]
    unsafe fn get_window_behavior(window: *mut std::ffi::c_void) -> usize {
        use std::ffi::{c_char, c_void};
        #[link(name = "objc")]
        unsafe extern "C" {
            fn sel_registerName(name: *const c_char) -> *mut c_void;
            #[link_name = "objc_msgSend"]
            fn send_message();
        }
        let selector = sel_registerName(c"collectionBehavior".as_ptr());
        let send: unsafe extern "C" fn(*mut c_void, *mut c_void) -> usize =
            std::mem::transmute(send_message as unsafe extern "C" fn());
        send(window, selector)
    }

    #[cfg(target_os = "macos")]
    fn set_selection_window_level(window: &WebviewWindow) -> Result<()> {
        #[link(name = "CoreGraphics", kind = "framework")]
        unsafe extern "C" {
            fn CGWindowLevelForKey(key: i32) -> i32;
        }
        let native = window.ns_window().map_err(|error| error.to_string())?;
        // Selection must receive clicks over the menu bar and Dock as well.
        // This function is called only on the native main thread.
        unsafe {
            send_window_message(native, c"setLevel:", CGWindowLevelForKey(11) as isize + 1);
            let behavior = get_window_behavior(native);
            send_window_message(
                native,
                c"setCollectionBehavior:",
                (behavior | (1 << 8)) as isize,
            );
        }
        Ok(())
    }
}

#[cfg(feature = "desktop")]
pub use desktop::{require_main, CapturePicker};

#[cfg(test)]
mod tests {
    use super::*;

    fn display() -> CaptureDevice {
        CaptureDevice {
            id: "screen:1".into(),
            name: "Left display".into(),
            kind: "screen".into(),
            width: Some(3000),
            height: Some(2000),
            bounds: Some(CaptureBounds {
                x: -3000.0,
                y: -200.0,
                width: 3000.0,
                height: 2000.0,
            }),
            scale_factor: Some(1.5),
        }
    }

    fn selection(source_id: &str) -> PickerSelection {
        PickerSelection {
            source_id: source_id.into(),
            region: None,
            output_size: None,
            microphone: None,
            audio_device: None,
            source_name: Some("untrusted name".into()),
            source_width: Some(1),
            source_height: Some(1),
        }
    }

    #[test]
    fn display_geometry_handles_negative_origins_and_mixed_scale() {
        let display = display();
        let mut window = display.clone();
        window.id = "window:4:7".into();
        window.kind = "window".into();
        window.width = Some(1200);
        window.height = Some(900);
        window.bounds = Some(CaptureBounds {
            x: -3300.0,
            y: 100.0,
            width: 1200.0,
            height: 900.0,
        });
        window.scale_factor = Some(2.0);
        let context = make_context(
            "test",
            &display,
            &[display.clone(), window],
            &PickerPreferences::default(),
            false,
        )
        .unwrap();
        assert_eq!(context.display.logical_width, 2000.0);
        assert_eq!(context.display.pixel_width, 3000);
        let rect = &context.targets[1].rect;
        assert_eq!(
            (rect.x, rect.y, rect.width, rect.height),
            (-200.0, 200.0, 800.0, 600.0)
        );
        assert_eq!(context.targets[1].source_width, 1200);
    }

    #[test]
    fn point_based_display_preserves_points_and_retina_pixel_dimensions() {
        let mut display = display();
        display.bounds = Some(CaptureBounds {
            x: -1500.0,
            y: 80.0,
            width: 1500.0,
            height: 1000.0,
        });
        display.scale_factor = Some(2.0);
        let context = make_context(
            "test",
            &display,
            &[display.clone()],
            &PickerPreferences::default(),
            true,
        )
        .unwrap();
        assert_eq!(context.display.logical_width, 1500.0);
        assert_eq!(context.display.pixel_width, 3000);
        assert_eq!(context.targets[0].rect.x, 0.0);
    }

    #[test]
    fn selection_checks_source_boundaries_and_restores_authoritative_metadata() {
        let display = display();
        let sources = vec![display.clone()];
        let mut chosen = selection(&display.id);
        chosen.region = Some(Region {
            x: 2984,
            y: 1984,
            width: 16,
            height: 16,
        });
        let accepted = validate_selection(chosen.clone(), &display, &sources).unwrap();
        assert_eq!(accepted.source_name, Some(display.name.clone()));
        assert_eq!(accepted.source_width, Some(3000));
        chosen.region.as_mut().unwrap().x += 1;
        assert!(validate_selection(chosen.clone(), &display, &sources).is_err());
        chosen.region.as_mut().unwrap().x = i32::MAX;
        chosen.region.as_mut().unwrap().width = u32::MAX;
        assert!(validate_selection(chosen, &display, &sources).is_err());
        assert!(validate_selection(selection("missing-window"), &display, &sources).is_err());
    }

    #[test]
    fn selected_window_is_never_converted_to_region_or_a_different_display() {
        let display = display();
        let mut window = display.clone();
        window.id = "window:3:4".into();
        window.kind = "window".into();
        let mut other_display = display.clone();
        other_display.id = "screen:2".into();
        let sources = vec![display.clone(), window.clone(), other_display.clone()];
        assert!(validate_selection(selection(&window.id), &display, &sources).is_ok());
        let mut chosen = selection(&window.id);
        chosen.region = Some(Region {
            x: 0,
            y: 0,
            width: 100,
            height: 100,
        });
        assert!(validate_selection(chosen, &display, &sources).is_err());
        assert!(validate_selection(selection(&other_display.id), &display, &sources).is_err());
    }

    #[test]
    fn request_and_output_dimensions_are_strict() {
        assert!(valid_request_id("capture-123_test"));
        for invalid in ["", "../main", "request?id=1", "a b"] {
            assert!(!valid_request_id(invalid));
        }
        let display = display();
        let mut chosen = selection(&display.id);
        chosen.output_size = Some(OutputSize {
            width: 1281,
            height: 720,
        });
        assert!(validate_selection(chosen.clone(), &display, &[display.clone()]).is_err());
        chosen.output_size = Some(OutputSize {
            width: 1280,
            height: 720,
        });
        assert!(validate_selection(chosen, &display, &[display.clone()]).is_ok());
    }

    #[test]
    fn microphone_defaults_on_and_preserves_an_explicit_choice() {
        let legacy: PickerPreferences = serde_json::from_value(serde_json::json!({
            "mode": "window"
        }))
        .unwrap();
        assert_eq!(
            normalized_preferences(legacy.clone()).microphone,
            Some(true)
        );
        assert_eq!(
            apply_audio_preference(selection("screen:1"), &legacy).microphone,
            Some(true)
        );
        let disabled = PickerPreferences {
            microphone: Some(false),
            ..PickerPreferences::default()
        };
        assert_eq!(
            normalized_preferences(disabled.clone()).microphone,
            Some(false)
        );
        assert_eq!(
            apply_audio_preference(selection("screen:1"), &disabled).microphone,
            Some(false)
        );
        let mut enabled = selection("screen:1");
        enabled.microphone = Some(true);
        assert_eq!(
            apply_audio_preference(enabled, &disabled).microphone,
            Some(true)
        );
        let mut chosen = selection("screen:1");
        chosen.microphone = Some(false);
        assert_eq!(
            apply_audio_preference(chosen, &legacy).microphone,
            Some(false)
        );
    }

    #[test]
    fn microphone_sources_preserve_native_ids_and_allow_returning_to_default() {
        let display = display();
        let audio = CaptureDevice {
            id: "native-microphone-unique-id".into(),
            name: "USB 麦克风".into(),
            kind: "audio".into(),
            ..CaptureDevice::default()
        };
        let sources = vec![display.clone(), audio.clone()];
        let preferences = PickerPreferences {
            microphone: Some(false),
            audio_device: Some(audio.id.clone()),
            ..PickerPreferences::default()
        };
        let context = make_context("test", &display, &sources, &preferences, true).unwrap();
        assert_eq!(context.targets.len(), 1);
        let context_json = serde_json::to_value(context).unwrap();
        assert_eq!(context_json["audioDevices"][0]["id"], audio.id);
        assert_eq!(context_json["audioDevices"][0]["name"], audio.name);
        assert_eq!(context_json["preferences"]["audioDevice"], audio.id);
        let empty_context =
            make_context("test", &display, &[display.clone()], &preferences, true).unwrap();
        assert_eq!(
            serde_json::to_value(empty_context).unwrap()["audioDevices"],
            serde_json::json!([])
        );

        let inherited = apply_audio_preference(selection(&display.id), &preferences);
        assert_eq!(inherited.audio_device.as_deref(), Some(audio.id.as_str()));
        assert_eq!(inherited.microphone, Some(false));
        assert!(validate_selection(inherited, &display, &sources).is_ok());

        let mut chosen = selection(&display.id);
        chosen.audio_device = Some(String::new());
        let reset = apply_audio_preference(chosen, &preferences);
        assert!(reset.audio_device.is_none());
    }

    #[test]
    fn missing_selected_microphone_is_not_replaced_with_another_device() {
        let display = display();
        let sources = vec![
            display.clone(),
            CaptureDevice {
                id: "other-microphone".into(),
                name: "另一个麦克风".into(),
                kind: "audio".into(),
                ..CaptureDevice::default()
            },
        ];
        let mut chosen = selection(&display.id);
        chosen.microphone = Some(true);
        chosen.audio_device = Some("disconnected-microphone".into());
        assert!(validate_selection(chosen.clone(), &display, &sources)
            .unwrap_err()
            .contains("所选麦克风已断开"));
        chosen.microphone = Some(false);
        let disabled = validate_selection(chosen, &display, &sources).unwrap();
        assert_eq!(
            disabled.audio_device.as_deref(),
            Some("disconnected-microphone")
        );
    }

    #[test]
    fn screenshots_never_return_a_microphone_preference() {
        let preferences = PickerPreferences {
            purpose: Some("screenshot".into()),
            microphone: Some(true),
            audio_device: Some("old-microphone".into()),
            ..PickerPreferences::default()
        };
        let sanitized = normalized_preferences(preferences.clone());
        let sanitized = serde_json::to_value(sanitized).unwrap();
        assert!(sanitized.get("microphone").is_none());
        assert!(sanitized.get("audioDevice").is_none());
        let mut chosen = selection("screen:1");
        chosen.microphone = Some(true);
        chosen.audio_device = Some("unavailable-microphone".into());
        let sanitized = apply_audio_preference(chosen, &preferences);
        let sanitized = serde_json::to_value(sanitized).unwrap();
        assert!(sanitized.get("microphone").is_none());
        assert!(sanitized.get("audioDevice").is_none());

        let display = display();
        let context = make_context(
            "screenshot",
            &display,
            &[
                display.clone(),
                CaptureDevice {
                    id: "available-microphone".into(),
                    kind: "audio".into(),
                    ..CaptureDevice::default()
                },
            ],
            &preferences,
            true,
        )
        .unwrap();
        assert!(serde_json::to_value(context)
            .unwrap()
            .get("audioDevices")
            .is_none());
    }
}
