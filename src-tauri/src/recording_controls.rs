//! A separate, protected control window follows the current recording bounds.

use crate::{
    capture::{CaptureBounds, CaptureDevice, Region},
    engine::Result,
};
use serde::{Deserialize, Serialize};

pub const WINDOW_LABEL: &str = "recording-controls";
pub const STATE_EVENT: &str = "capture-controls-state";
pub const ACTION_EVENT: &str = "capture-controls-action";
const WIDTH: f64 = 244.0;
const HEIGHT: f64 = 44.0;
const MARGIN: f64 = 8.0;
const COUNTDOWN_SIZE: f64 = 176.0;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlsSnapshot {
    pub phase: String,
    pub elapsed: f64,
    pub muted: bool,
    pub audio_available: bool,
    pub microphone_enabled: bool,
    pub microphone_pending: bool,
    pub busy: bool,
    pub error: Option<String>,
    pub countdown: Option<u32>,
}

impl Default for ControlsSnapshot {
    fn default() -> Self {
        Self {
            phase: "starting".into(),
            elapsed: 0.0,
            muted: false,
            audio_available: false,
            microphone_enabled: false,
            microphone_pending: false,
            busy: true,
            error: None,
            countdown: None,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ControlsAction {
    Pause,
    Resume,
    Stop,
    ToggleMicrophone,
}

#[derive(Clone, Debug, Serialize)]
pub struct ActionMessage {
    pub action: ControlsAction,
}

fn valid_bounds(bounds: &CaptureBounds) -> bool {
    [bounds.x, bounds.y, bounds.width, bounds.height]
        .iter()
        .all(|value| value.is_finite())
        && bounds.width > 0.0
        && bounds.height > 0.0
}

fn selection_bounds(source: &CaptureDevice, region: Option<&Region>) -> Result<CaptureBounds> {
    let bounds = source.bounds.as_ref().ok_or("录制来源位置不可用。")?;
    if !valid_bounds(bounds) {
        return Err("录制来源位置无效。".into());
    }
    let Some(region) = region else {
        return Ok(bounds.clone());
    };
    let width = source
        .width
        .filter(|width| *width > 0)
        .ok_or("录制来源宽度不可用。")?;
    let height = source
        .height
        .filter(|height| *height > 0)
        .ok_or("录制来源高度不可用。")?;
    if source.kind != "screen"
        || region.x < 0
        || region.y < 0
        || region.width < 16
        || region.height < 16
        || u64::from(region.x as u32) + u64::from(region.width) > u64::from(width)
        || u64::from(region.y as u32) + u64::from(region.height) > u64::from(height)
    {
        return Err("录制控制栏的区域超出所选屏幕。".into());
    }
    // Selection pixels and native desktop coordinates differ on scaled displays.
    let scale_x = bounds.width / f64::from(width);
    let scale_y = bounds.height / f64::from(height);
    Ok(CaptureBounds {
        x: bounds.x + f64::from(region.x) * scale_x,
        y: bounds.y + f64::from(region.y) * scale_y,
        width: f64::from(region.width) * scale_x,
        height: f64::from(region.height) * scale_y,
    })
}

fn placement(target: &CaptureBounds, work_area: &CaptureBounds, scale: f64) -> (f64, f64) {
    let width = WIDTH * scale;
    let height = HEIGHT * scale;
    let margin = MARGIN * scale;
    let min_x = work_area.x + margin;
    let min_y = work_area.y + margin;
    let max_x = (work_area.x + work_area.width - width - margin).max(min_x);
    let max_y = (work_area.y + work_area.height - height - margin).max(min_y);
    let above = target.y - height - margin;
    let y = if above >= min_y {
        above
    } else {
        target.y + margin
    };
    (
        (target.x + target.width - width).clamp(min_x, max_x),
        y.clamp(min_y, max_y),
    )
}

fn countdown_placement(target: &CaptureBounds, screen: &CaptureBounds, scale: f64) -> (f64, f64) {
    let size = COUNTDOWN_SIZE * scale;
    // Very small selections at a screen edge must still leave Cancel reachable.
    (
        (target.x + (target.width - size) / 2.0).clamp(screen.x, (screen.x + screen.width - size).max(screen.x)),
        (target.y + (target.height - size) / 2.0).clamp(screen.y, (screen.y + screen.height - size).max(screen.y)),
    )
}

fn focused_bounds(bounds: CaptureBounds, state_path: Option<&std::path::Path>) -> CaptureBounds {
    let viewport = state_path.and_then(|path| std::fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice::<CaptureBounds>(&bytes).ok());
    let Some(viewport) = viewport.filter(|viewport| valid_bounds(viewport)
        && viewport.x >= 0.0 && viewport.y >= 0.0
        && viewport.x + viewport.width <= 1.0 + 1e-9
        && viewport.y + viewport.height <= 1.0 + 1e-9) else { return bounds; };
    CaptureBounds {
        x: bounds.x + viewport.x * bounds.width,
        y: bounds.y + viewport.y * bounds.height,
        width: bounds.width * viewport.width,
        height: bounds.height * viewport.height,
    }
}

/// Poll cancellation while waiting, including before the first visible tick.
pub fn countdown_wait(
    seconds: u32,
    cancelled: &std::sync::atomic::AtomicBool,
    mut tick: impl FnMut(Option<u32>) -> Result<()>,
) -> Result<()> {
    use std::{sync::atomic::Ordering, time::{Duration, Instant}};
    if seconds > 10 { return Err("录制倒计时应为 0 至 10 秒。".into()); }
    let check = || if cancelled.load(Ordering::SeqCst) { Err("录制已取消。".to_string()) } else { Ok(()) };
    check()?;
    for remaining in (1..=seconds).rev() {
        tick(Some(remaining))?;
        let until = Instant::now() + Duration::from_secs(1);
        while Instant::now() < until {
            check()?;
            std::thread::sleep(until.saturating_duration_since(Instant::now()).min(Duration::from_millis(25)));
        }
    }
    check()?;
    tick(None)
}

#[cfg(feature = "desktop")]
mod desktop {
    use super::*;
    use std::{
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc, Mutex,
        },
        time::Duration,
    };
    use tauri::{Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

    #[derive(Clone)]
    struct Target {
        source: CaptureDevice,
        region: Option<Region>,
        zoom_state_path: Option<std::path::PathBuf>,
    }

    struct Session {
        snapshot: ControlsSnapshot,
        target: Option<Target>,
        cancelled: Arc<AtomicBool>,
        ready: bool,
    }

    #[derive(Clone, Default)]
    pub struct ControlsManager {
        inner: Arc<Mutex<Option<Session>>>,
    }

    impl ControlsManager {
        /// Must complete before native capture starts so display filters can exclude this window.
        pub async fn prepare(
            &self,
            app: &tauri::AppHandle,
            snapshot: ControlsSnapshot,
        ) -> Result<()> {
            validate_snapshot(&snapshot)?;
            let cancelled = Arc::new(AtomicBool::new(false));
            {
                let mut inner = self.inner.lock().map_err(|_| "录制控制状态不可用。")?;
                if inner.is_some() {
                    return Err("录制控制栏已打开，请先结束当前录制。".into());
                }
                *inner = Some(Session {
                    snapshot,
                    target: None,
                    cancelled: cancelled.clone(),
                    ready: false,
                });
            }
            let manager = self.clone();
            let native_app = app.clone();
            let token = cancelled.clone();
            let result = tauri::async_runtime::spawn_blocking(move || {
                #[cfg(target_os = "macos")]
                {
                    let (sender, receiver) = std::sync::mpsc::channel();
                    let dispatch = native_app.clone();
                    native_app
                        .run_on_main_thread(move || {
                            let _ = sender.send(manager.create_window(&dispatch, &token));
                        })
                        .map_err(|error| error.to_string())?;
                    receiver
                        .recv_timeout(Duration::from_secs(15))
                        .map_err(|_| "创建录制控制栏超时，请重试。".to_string())?
                }
                #[cfg(not(target_os = "macos"))]
                {
                    // Native window creation on Windows must run outside its event callback.
                    manager.create_window(&native_app, &token)
                }
            })
            .await
            .map_err(|error| format!("无法创建录制控制栏：{error}"))
            .and_then(|result| result);
            if let Err(error) = result {
                self.close_if_current(app, &cancelled);
                return Err(error);
            }
            if !self.is_current(&cancelled) {
                return Err("录制已取消。".into());
            }
            self.start_tracker(app, cancelled);
            Ok(())
        }

        fn create_window(&self, app: &tauri::AppHandle, token: &Arc<AtomicBool>) -> Result<()> {
            if !self.is_current(token) {
                return Err("录制已取消。".into());
            }
            let window = WebviewWindowBuilder::new(
                app,
                WINDOW_LABEL,
                WebviewUrl::App("index.html?recording-controls".into()),
            )
            .title("Open Media 录制控制")
            .inner_size(WIDTH, HEIGHT)
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
            .focusable(false)
            .focused(false)
            .visible(false)
            .build()
            .map_err(|error| format!("无法打开录制控制栏：{error}"))?;
            if !self.is_current(token) {
                let _ = window.destroy();
                return Err("录制已取消。".into());
            }
            set_native_level(&window)?;
            // Stay hidden until validated source bounds are known; never flash at a default corner.
            Ok(())
        }

        pub fn set_target(
            &self,
            app: &tauri::AppHandle,
            source: CaptureDevice,
            region: Option<Region>,
            zoom_state_path: Option<std::path::PathBuf>,
        ) -> Result<()> {
            selection_bounds(&source, region.as_ref())?;
            let (target, token) = {
                let mut inner = self.inner.lock().map_err(|_| "录制控制状态不可用。")?;
                let session = inner.as_mut().ok_or("录制控制栏已关闭。")?;
                let target = Target { source, region, zoom_state_path };
                session.target = Some(target.clone());
                (target, session.cancelled.clone())
            };
            self.queue_position(app, &token, Some(target));
            Ok(())
        }

        pub fn snapshot(&self) -> Result<ControlsSnapshot> {
            self.inner
                .lock()
                .map_err(|_| "录制控制状态不可用。")?
                .as_ref()
                .map(|session| session.snapshot.clone())
                .ok_or_else(|| "录制控制栏已关闭。".into())
        }

        pub fn ready(&self, _app: &tauri::AppHandle, label: &str) -> Result<ControlsSnapshot> {
            require_controls(label)?;
            let mut inner = self.inner.lock().map_err(|_| "录制控制状态不可用。")?;
            let session = inner.as_mut().ok_or("录制控制栏已关闭。")?;
            session.ready = true;
            Ok(session.snapshot.clone())
        }

        pub fn wait_ready(&self, cancelled: &AtomicBool) -> Result<()> {
            let deadline = std::time::Instant::now() + Duration::from_secs(15);
            loop {
                if cancelled.load(Ordering::SeqCst) { return Err("录制已取消。".into()); }
                let ready = self.inner.lock().map_err(|_| "录制控制状态不可用。")?
                    .as_ref().ok_or("录制控制栏已关闭。")?.ready;
                if ready { return Ok(()); }
                if std::time::Instant::now() >= deadline { return Err("录制倒计时窗口加载超时，请重试。".into()); }
                std::thread::sleep(Duration::from_millis(25));
            }
        }

        pub fn sync(&self, app: &tauri::AppHandle, snapshot: ControlsSnapshot) -> Result<()> {
            validate_snapshot(&snapshot)?;
            let (target, token, changed_phase) = {
                let mut inner = self.inner.lock().map_err(|_| "录制控制状态不可用。")?;
                let session = inner.as_mut().ok_or("录制控制栏已关闭。")?;
                let changed_phase = session.snapshot.phase != snapshot.phase;
                session.snapshot = snapshot.clone();
                (session.target.clone(), session.cancelled.clone(), changed_phase)
            };
            if changed_phase { self.queue_position(app, &token, target); }
            if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
                window
                    .emit(STATE_EVENT, snapshot)
                    .map_err(|error| error.to_string())?;
            }
            Ok(())
        }

        pub fn action(
            &self,
            app: &tauri::AppHandle,
            label: &str,
            action: ControlsAction,
        ) -> Result<()> {
            require_controls(label)?;
            let snapshot = self.snapshot()?;
            let allowed = (!snapshot.busy
                || matches!(action, ControlsAction::Stop) && (snapshot.microphone_pending || snapshot.phase == "starting"))
                && match action {
                    ControlsAction::Pause => snapshot.phase == "recording",
                    ControlsAction::Resume => snapshot.phase == "paused",
                    ControlsAction::Stop => {
                        matches!(snapshot.phase.as_str(), "starting" | "recording" | "paused")
                    }
                    ControlsAction::ToggleMicrophone => {
                        matches!(snapshot.phase.as_str(), "recording" | "paused")
                    }
                };
            if !allowed {
                return Err("当前录制状态不能执行此操作，请稍后重试。".into());
            }
            app.get_webview_window("main")
                .ok_or("主窗口已关闭。")?
                .emit(ACTION_EVENT, ActionMessage { action })
                .map_err(|error| error.to_string())
        }

        pub fn close(&self, app: &tauri::AppHandle) {
            let token = self
                .inner
                .lock()
                .ok()
                .and_then(|inner| inner.as_ref().map(|session| session.cancelled.clone()));
            if let Some(token) = token {
                self.close_if_current(app, &token);
            }
        }

        fn close_if_current(&self, app: &tauri::AppHandle, token: &Arc<AtomicBool>) {
            let closing = if let Ok(inner) = self.inner.lock() {
                if inner
                    .as_ref()
                    .is_some_and(|session| Arc::ptr_eq(&session.cancelled, token))
                    && !token.swap(true, Ordering::SeqCst)
                {
                    true
                } else {
                    false
                }
            } else {
                false
            };
            if closing {
                if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
                    let _ = window.destroy();
                }
                // Do not admit another session until this window has been destroyed.
                if let Ok(mut inner) = self.inner.lock() {
                    if inner
                        .as_ref()
                        .is_some_and(|session| Arc::ptr_eq(&session.cancelled, token))
                    {
                        inner.take();
                    }
                }
            }
        }

        fn is_current(&self, token: &Arc<AtomicBool>) -> bool {
            !token.load(Ordering::SeqCst)
                && self.inner.lock().ok().is_some_and(|inner| {
                    inner
                        .as_ref()
                        .is_some_and(|session| Arc::ptr_eq(&session.cancelled, token))
                })
        }

        fn start_tracker(&self, app: &tauri::AppHandle, token: Arc<AtomicBool>) {
            let manager = self.clone();
            let app = app.clone();
            std::thread::spawn(move || {
                while manager.is_current(&token) {
                    let target = manager.inner.lock().ok().and_then(|inner| {
                        inner.as_ref().and_then(|session| session.target.clone())
                    });
                    if target.is_some() {
                        manager.queue_position(&app, &token, target);
                    }
                    std::thread::sleep(Duration::from_millis(250));
                }
            });
        }

        fn queue_position(
            &self,
            app: &tauri::AppHandle,
            token: &Arc<AtomicBool>,
            target: Option<Target>,
        ) {
            // A native geometry lookup does not enumerate capture sources or ask for permissions.
            let target = target.and_then(|target| current_bounds(&target).ok());
            let Some(bounds) = target else { return };
            let manager = self.clone();
            let token = token.clone();
            let dispatch = app.clone();
            let _ = app.run_on_main_thread(move || {
                if manager.is_current(&token) {
                    if let Some(window) = dispatch.get_webview_window(WINDOW_LABEL) {
                        // Keep the last accessible position when a target is minimized or gone.
                        let starting = manager.snapshot().is_ok_and(|snapshot| snapshot.phase == "starting");
                        let _ = position_window(&window, Some(&bounds), starting);
                        let _ = window.show();
                    }
                }
            });
        }
    }

    fn validate_snapshot(snapshot: &ControlsSnapshot) -> Result<()> {
        if !snapshot.elapsed.is_finite() || snapshot.elapsed < 0.0 {
            return Err("录制时长无效。".into());
        }
        if ![
            "idle",
            "starting",
            "recording",
            "paused",
            "stopping",
            "error",
        ]
        .contains(&snapshot.phase.as_str())
        {
            return Err("录制状态无效。".into());
        }
        Ok(())
    }

    pub fn require_controls(label: &str) -> Result<()> {
        if label == WINDOW_LABEL {
            Ok(())
        } else {
            Err("当前窗口不能操作录制控制栏。".into())
        }
    }

    fn current_bounds(target: &Target) -> Result<CaptureBounds> {
        let mut source = target.source.clone();
        #[cfg(target_os = "macos")]
        if source.kind == "window" {
            unsafe extern "C" {
                fn open_media_capture_window_bounds(
                    window_id: u32,
                    x: *mut f64,
                    y: *mut f64,
                    width: *mut f64,
                    height: *mut f64,
                ) -> i32;
            }
            let id = source
                .id
                .strip_prefix("window:")
                .and_then(|id| id.parse::<u32>().ok())
                .filter(|id| *id > 0)
                .ok_or("录制窗口编号无效。")?;
            let mut bounds = CaptureBounds {
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: 0.0,
            };
            let available = unsafe {
                open_media_capture_window_bounds(
                    id,
                    &mut bounds.x,
                    &mut bounds.y,
                    &mut bounds.width,
                    &mut bounds.height,
                )
            };
            if available != 1 || !valid_bounds(&bounds) {
                return Err("录制窗口当前不可见。".into());
            }
            source.bounds = Some(bounds);
        }
        #[cfg(target_os = "windows")]
        {
            let current = crate::capture_windows::resolve_target(&source.id)?;
            source.bounds = Some(CaptureBounds {
                x: f64::from(current.bounds.x),
                y: f64::from(current.bounds.y),
                width: f64::from(current.bounds.width),
                height: f64::from(current.bounds.height),
            });
        }
        selection_bounds(&source, target.region.as_ref()).map(|bounds| focused_bounds(bounds, target.zoom_state_path.as_deref()))
    }

    fn monitor_bounds(monitor: &tauri::Monitor, work_area: bool) -> CaptureBounds {
        let (position, size) = if work_area {
            let area = monitor.work_area();
            (area.position, area.size)
        } else {
            (*monitor.position(), *monitor.size())
        };
        let scale = if cfg!(target_os = "macos") {
            monitor.scale_factor()
        } else {
            1.0
        };
        CaptureBounds {
            x: f64::from(position.x) / scale,
            y: f64::from(position.y) / scale,
            width: f64::from(size.width) / scale,
            height: f64::from(size.height) / scale,
        }
    }

    fn position_window(window: &WebviewWindow, target: Option<&CaptureBounds>, starting: bool) -> Result<()> {
        let monitors = window
            .available_monitors()
            .map_err(|error| error.to_string())?;
        let monitor = target
            .and_then(|target| {
                let x = target.x + target.width - 1.0;
                let y = target.y + 1.0;
                monitors.iter().find(|monitor| {
                    let bounds = monitor_bounds(monitor, false);
                    x >= bounds.x
                        && x < bounds.x + bounds.width
                        && y >= bounds.y
                        && y < bounds.y + bounds.height
                })
            })
            .cloned()
            .or(window
                .current_monitor()
                .map_err(|error| error.to_string())?)
            .or(window
                .primary_monitor()
                .map_err(|error| error.to_string())?)
            .or_else(|| monitors.into_iter().next())
            .ok_or("没有可用于显示录制控制栏的屏幕。")?;
        let work_area = monitor_bounds(&monitor, true);
        let scale = if cfg!(target_os = "macos") {
            1.0
        } else {
            monitor.scale_factor()
        };
        let target = target.unwrap_or(&work_area);
        let (x, y) = if starting { countdown_placement(target, &work_area, scale) } else { placement(target, &work_area, scale) };
        let (width, height) = if starting { (COUNTDOWN_SIZE, COUNTDOWN_SIZE) } else { (WIDTH, HEIGHT) };
        let size = tauri::LogicalSize::new(width, height);
        if window.inner_size().map_err(|error| error.to_string())?
            != size.to_physical::<u32>(window.scale_factor().map_err(|error| error.to_string())?) {
            window.set_size(size).map_err(|error| error.to_string())?;
        }
        #[cfg(target_os = "macos")]
        window
            .set_position(tauri::LogicalPosition::new(x, y))
            .map_err(|error| error.to_string())?;
        #[cfg(not(target_os = "macos"))]
        window
            .set_position(tauri::PhysicalPosition::new(
                x.round() as i32,
                y.round() as i32,
            ))
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    #[cfg(target_os = "macos")]
    fn set_native_level(window: &WebviewWindow) -> Result<()> {
        use std::ffi::{c_char, c_void};
        #[link(name = "objc")]
        unsafe extern "C" {
            fn sel_registerName(name: *const c_char) -> *mut c_void;
            #[link_name = "objc_msgSend"]
            fn send_message();
        }
        #[link(name = "CoreGraphics", kind = "framework")]
        unsafe extern "C" {
            fn CGWindowLevelForKey(key: i32) -> i32;
        }
        let native = window.ns_window().map_err(|error| error.to_string())?;
        // Stay above the boundary indicator without activating or focusing the recorded app.
        unsafe {
            let selector = sel_registerName(c"setLevel:".as_ptr());
            let send: unsafe extern "C" fn(*mut c_void, *mut c_void, isize) =
                std::mem::transmute(send_message as unsafe extern "C" fn());
            send(native, selector, CGWindowLevelForKey(13) as isize + 1);
            let get: unsafe extern "C" fn(*mut c_void, *mut c_void) -> usize =
                std::mem::transmute(send_message as unsafe extern "C" fn());
            let behavior = get(native, sel_registerName(c"collectionBehavior".as_ptr()));
            send(
                native,
                sel_registerName(c"setCollectionBehavior:".as_ptr()),
                (behavior | (1 << 8)) as isize,
            );
        }
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    fn set_native_level(_window: &WebviewWindow) -> Result<()> {
        Ok(())
    }
}

#[cfg(feature = "desktop")]
pub use desktop::{require_controls, ControlsManager};

#[cfg(test)]
mod tests {
    use super::*;

    fn bounds(x: f64, y: f64, width: f64, height: f64) -> CaptureBounds {
        CaptureBounds {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn countdown_is_centered_in_selected_region_on_scaled_and_secondary_displays() {
        for (target, scale) in [
            (bounds(220.0, 140.0, 800.0, 600.0), 1.0),
            (bounds(-1920.0, -600.0, 1600.0, 900.0), 1.5),
            (bounds(3840.0, 320.0, 1200.0, 800.0), 2.0),
        ] {
            let (x, y) = countdown_placement(&target, &bounds(-4000.0, -2000.0, 12000.0, 6000.0), scale);
            assert_eq!(x + COUNTDOWN_SIZE * scale / 2.0, target.x + target.width / 2.0);
            assert_eq!(y + COUNTDOWN_SIZE * scale / 2.0, target.y + target.height / 2.0);
        }
    }

    #[test]
    fn countdown_cancel_remains_on_screen_for_tiny_edge_selections() {
        let screen = bounds(-1920.0, 24.0, 1920.0, 1056.0);
        for target in [bounds(-1920.0, 24.0, 16.0, 16.0), bounds(-16.0, 1064.0, 16.0, 16.0)] {
            let (x, y) = countdown_placement(&target, &screen, 1.0);
            assert!(x >= screen.x && y >= screen.y);
            assert!(x + COUNTDOWN_SIZE <= screen.x + screen.width);
            assert!(y + COUNTDOWN_SIZE <= screen.y + screen.height);
        }
    }

    #[test]
    fn countdown_can_cancel_before_recording_without_finishing_remaining_ticks() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let cancelled = AtomicBool::new(false);
        let mut ticks = Vec::new();
        let result = countdown_wait(3, &cancelled, |tick| {
            ticks.push(tick);
            cancelled.store(true, Ordering::SeqCst);
            Ok(())
        });
        assert!(result.unwrap_err().contains("取消"));
        assert_eq!(ticks, [Some(3)]);
        ticks.clear();
        assert!(countdown_wait(0, &cancelled, |tick| { ticks.push(tick); Ok(()) }).is_err());
        assert!(ticks.is_empty());
    }

    #[test]
    fn disabled_countdown_starts_immediately_and_invalid_durations_are_rejected() {
        let cancelled = std::sync::atomic::AtomicBool::new(false);
        let mut ticks = Vec::new();
        countdown_wait(0, &cancelled, |tick| { ticks.push(tick); Ok(()) }).unwrap();
        assert_eq!(ticks, [None]);
        assert!(countdown_wait(11, &cancelled, |_| panic!("invalid timer must never start")).is_err());
    }

    #[test]
    fn controls_follow_zoom_in_original_bounds_and_ignore_corrupt_state() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("capture-viewport.json");
        std::fs::write(&path, br#"{"x":0.25,"y":0.125,"width":0.5,"height":0.5}"#).unwrap();
        let result = focused_bounds(bounds(-1000.0, 100.0, 800.0, 600.0), Some(&path));
        assert_eq!((result.x, result.y, result.width, result.height), (-800.0, 175.0, 400.0, 300.0));
        for invalid in [r#"{"x":0.9,"y":0,"width":0.5,"height":0.5}"#, r#"{"x":0,"y":0,"width":0,"height":0.5}"#, "{"] {
            std::fs::write(&path, invalid).unwrap();
            let result = focused_bounds(bounds(100.0, 200.0, 800.0, 600.0), Some(&path));
            assert_eq!((result.x, result.y, result.width, result.height), (100.0, 200.0, 800.0, 600.0));
        }
    }

    #[test]
    fn toolbar_stays_above_the_selected_bounds_when_space_is_available() {
        assert_eq!(
            placement(
                &bounds(100.0, 200.0, 800.0, 600.0),
                &bounds(0.0, 25.0, 1920.0, 1015.0),
                1.0
            ),
            (656.0, 148.0)
        );
    }

    #[test]
    fn top_edge_and_small_regions_keep_all_controls_on_screen() {
        assert_eq!(
            placement(
                &bounds(0.0, 0.0, 100.0, 100.0),
                &bounds(0.0, 25.0, 1920.0, 1015.0),
                1.0
            ),
            (8.0, 33.0)
        );
        assert_eq!(
            placement(
                &bounds(-1920.0, -1080.0, 1920.0, 1080.0),
                &bounds(-1920.0, -1055.0, 1920.0, 1055.0),
                1.0
            ),
            (-252.0, -1047.0)
        );
    }

    #[test]
    fn display_pixel_selection_maps_to_native_logical_coordinates() {
        let source = CaptureDevice {
            kind: "screen".into(),
            width: Some(3840),
            height: Some(2160),
            bounds: Some(bounds(-1920.0, 0.0, 1920.0, 1080.0)),
            ..Default::default()
        };
        let selected = selection_bounds(
            &source,
            Some(&Region {
                x: 200,
                y: 100,
                width: 1000,
                height: 800,
            }),
        )
        .unwrap();
        assert_eq!(
            (selected.x, selected.y, selected.width, selected.height),
            (-1820.0, 50.0, 500.0, 400.0)
        );
        assert!(selection_bounds(
            &source,
            Some(&Region {
                x: -1,
                y: 0,
                width: 1000,
                height: 800
            })
        )
        .is_err());
    }

    #[test]
    fn scaled_controls_stay_within_physical_work_area() {
        assert_eq!(
            placement(
                &bounds(0.0, 0.0, 3840.0, 2160.0),
                &bounds(0.0, 0.0, 3840.0, 2080.0),
                2.0
            ),
            (3336.0, 16.0)
        );
    }
}
