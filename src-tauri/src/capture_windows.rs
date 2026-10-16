//! Native recording targets and the recording boundary indicator.
#![cfg_attr(not(windows), allow(dead_code))]

use crate::engine::Result;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug)]
pub struct VisualTarget {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub bounds: CaptureBounds,
    pub scale_factor: f64,
}

/// Convert source-relative screen coordinates to physical desktop coordinates.
pub fn capture_bounds(
    target: &VisualTarget,
    region: Option<&CaptureBounds>,
) -> Result<CaptureBounds> {
    let Some(region) = region else {
        return Ok(target.bounds.clone());
    };
    if target.kind != "screen" {
        return Err("窗口录制使用完整窗口，请选择屏幕后设置录制区域。".into());
    }
    if region.x < 0
        || region.y < 0
        || region.width < 16
        || region.height < 16
        || i64::from(region.x) + i64::from(region.width) > i64::from(target.bounds.width)
        || i64::from(region.y) + i64::from(region.height) > i64::from(target.bounds.height)
    {
        return Err("录制区域超出所选屏幕，请重新设置位置和尺寸。".into());
    }
    Ok(CaptureBounds {
        x: target
            .bounds
            .x
            .checked_add(region.x)
            .ok_or("录制区域位置无效。")?,
        y: target
            .bounds
            .y
            .checked_add(region.y)
            .ok_or("录制区域位置无效。")?,
        width: region.width,
        height: region.height,
    })
}

fn parse_window_id(id: &str) -> Result<(usize, u32)> {
    let (handle, pid) = id
        .strip_prefix("window:")
        .and_then(|s| s.split_once(':'))
        .ok_or("请选择有效的录制窗口。")?;
    if handle.is_empty()
        || pid.is_empty()
        || !handle.bytes().all(|c| c.is_ascii_digit())
        || !pid.bytes().all(|c| c.is_ascii_digit())
    {
        return Err("请选择有效的录制窗口。".into());
    }
    let handle = handle.parse::<usize>().map_err(|_| "录制窗口编号无效。")?;
    let pid = pid.parse::<u32>().map_err(|_| "录制窗口编号无效。")?;
    if handle == 0 || pid == 0 {
        return Err("请选择有效的录制窗口。".into());
    }
    Ok((handle, pid))
}

pub fn window_handle(id: &str) -> Result<usize> {
    parse_window_id(id).map(|(handle, _)| handle)
}

fn tracked_bounds(
    initial: &VisualTarget,
    current: &VisualTarget,
    region: Option<&CaptureBounds>,
) -> Result<CaptureBounds> {
    if initial.id != current.id || initial.kind != current.kind {
        return Err("录制目标已改变，请重新选择后继续。".into());
    }
    if initial.bounds.width != current.bounds.width
        || initial.bounds.height != current.bounds.height
    {
        return Err("录制目标尺寸已改变，已暂停录制。请确认新的尺寸后继续录制。".into());
    }
    if initial.kind == "screen"
        && (initial.bounds.x != current.bounds.x || initial.bounds.y != current.bounds.y)
    {
        return Err("屏幕布局已改变，已暂停录制。请确认录制区域后继续录制。".into());
    }
    capture_bounds(current, region)
}

/// Four narrow windows leave the recorded content interactive and unobstructed.
fn border_rects(bounds: &CaptureBounds) -> [CaptureBounds; 4] {
    let thickness = 3_u32.min(bounds.width).min(bounds.height);
    let right = (i64::from(bounds.x) + i64::from(bounds.width - thickness)) as i32;
    let bottom = (i64::from(bounds.y) + i64::from(bounds.height - thickness)) as i32;
    [
        CaptureBounds {
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: thickness,
        },
        CaptureBounds {
            x: bounds.x,
            y: bottom,
            width: bounds.width,
            height: thickness,
        },
        CaptureBounds {
            x: bounds.x,
            y: bounds.y,
            width: thickness,
            height: bounds.height,
        },
        CaptureBounds {
            x: right,
            y: bounds.y,
            width: thickness,
            height: bounds.height,
        },
    ]
}

#[cfg(windows)]
pub use platform::{list_targets, resolve_target, BorderIndicator};

#[cfg(not(windows))]
pub fn list_targets() -> Result<Vec<VisualTarget>> {
    Err("当前平台不支持此录制目标选择方式。".into())
}

#[cfg(not(windows))]
pub fn resolve_target(_id: &str) -> Result<VisualTarget> {
    Err("当前平台不支持此录制目标选择方式。".into())
}

#[cfg(not(windows))]
pub struct BorderIndicator;

#[cfg(not(windows))]
impl BorderIndicator {
    pub fn start(_target: VisualTarget, _region: Option<CaptureBounds>) -> Result<Self> {
        Err("当前平台不支持此录制边框。".into())
    }
    pub fn error(&self) -> Option<String> {
        None
    }
}

#[cfg(windows)]
#[allow(non_snake_case)]
mod platform {
    use super::{
        border_rects, capture_bounds, parse_window_id, tracked_bounds, CaptureBounds, Result,
        VisualTarget,
    };
    use std::{
        ffi::c_void,
        mem::{size_of, zeroed},
        ptr::{null, null_mut},
        sync::{
            atomic::{AtomicU64, Ordering},
            mpsc::{self, Receiver, RecvTimeoutError, Sender},
            Arc, Mutex,
        },
        thread::{self, JoinHandle},
        time::Duration,
    };

    type Handle = *mut c_void;
    type Hwnd = Handle;
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct Point {
        x: i32,
        y: i32,
    }
    #[repr(C)]
    struct MonitorInfo {
        size: u32,
        monitor: Rect,
        work: Rect,
        flags: u32,
        device: [u16; 32],
    }
    #[repr(C)]
    struct SystemVersion {
        size: u32,
        major: u32,
        minor: u32,
        build: u32,
        platform: u32,
        service_pack: [u16; 128],
    }
    #[repr(C)]
    struct WindowClass {
        style: u32,
        proc: Option<unsafe extern "system" fn(Hwnd, u32, usize, isize) -> isize>,
        class_extra: i32,
        window_extra: i32,
        instance: Handle,
        icon: Handle,
        cursor: Handle,
        background: Handle,
        menu_name: *const u16,
        class_name: *const u16,
    }
    #[repr(C)]
    struct Message {
        window: Hwnd,
        message: u32,
        wparam: usize,
        lparam: isize,
        time: u32,
        point: Point,
        private: u32,
    }
    #[link(name = "user32")]
    extern "system" {
        fn EnumWindows(callback: unsafe extern "system" fn(Hwnd, isize) -> i32, data: isize)
            -> i32;
        fn EnumDisplayMonitors(
            dc: Handle,
            clip: *const Rect,
            callback: unsafe extern "system" fn(Handle, Handle, *mut Rect, isize) -> i32,
            data: isize,
        ) -> i32;
        fn GetMonitorInfoW(monitor: Handle, info: *mut MonitorInfo) -> i32;
        fn IsWindow(window: Hwnd) -> i32;
        fn IsWindowVisible(window: Hwnd) -> i32;
        fn IsIconic(window: Hwnd) -> i32;
        fn GetWindowTextLengthW(window: Hwnd) -> i32;
        fn GetWindowTextW(window: Hwnd, text: *mut u16, count: i32) -> i32;
        fn GetWindowThreadProcessId(window: Hwnd, pid: *mut u32) -> u32;
        fn GetWindowLongPtrW(window: Hwnd, index: i32) -> isize;
        fn GetClientRect(window: Hwnd, rect: *mut Rect) -> i32;
        fn ClientToScreen(window: Hwnd, point: *mut Point) -> i32;
        fn GetDpiForWindow(window: Hwnd) -> u32;
        fn SetThreadDpiAwarenessContext(context: Handle) -> Handle;
        fn RegisterClassW(class: *const WindowClass) -> u16;
        fn UnregisterClassW(name: *const u16, instance: Handle) -> i32;
        fn CreateWindowExW(
            ex_style: u32,
            class: *const u16,
            title: *const u16,
            style: u32,
            x: i32,
            y: i32,
            width: i32,
            height: i32,
            parent: Hwnd,
            menu: Handle,
            instance: Handle,
            param: *mut c_void,
        ) -> Hwnd;
        fn DestroyWindow(window: Hwnd) -> i32;
        fn ShowWindow(window: Hwnd, command: i32) -> i32;
        fn SetWindowPos(
            window: Hwnd,
            insert_after: Hwnd,
            x: i32,
            y: i32,
            width: i32,
            height: i32,
            flags: u32,
        ) -> i32;
        fn SetLayeredWindowAttributes(window: Hwnd, key: u32, alpha: u8, flags: u32) -> i32;
        fn SetWindowDisplayAffinity(window: Hwnd, affinity: u32) -> i32;
        fn GetWindowDisplayAffinity(window: Hwnd, affinity: *mut u32) -> i32;
        fn DefWindowProcW(window: Hwnd, message: u32, wparam: usize, lparam: isize) -> isize;
        fn PeekMessageW(
            message: *mut Message,
            window: Hwnd,
            min: u32,
            max: u32,
            remove: u32,
        ) -> i32;
        fn TranslateMessage(message: *const Message) -> i32;
        fn DispatchMessageW(message: *const Message) -> isize;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentProcessId() -> u32;
        fn GetModuleHandleW(name: *const u16) -> Handle;
    }
    #[link(name = "dwmapi")]
    extern "system" {
        fn DwmGetWindowAttribute(
            window: Hwnd,
            attribute: u32,
            value: *mut c_void,
            size: u32,
        ) -> i32;
    }
    #[link(name = "shcore")]
    extern "system" {
        fn GetDpiForMonitor(monitor: Handle, kind: u32, x: *mut u32, y: *mut u32) -> i32;
    }
    #[link(name = "gdi32")]
    extern "system" {
        fn CreateSolidBrush(color: u32) -> Handle;
        fn DeleteObject(object: Handle) -> i32;
    }
    #[link(name = "ntdll")]
    extern "system" {
        fn RtlGetVersion(version: *mut SystemVersion) -> i32;
    }

    struct PhysicalCoordinates(Handle);
    impl PhysicalCoordinates {
        fn enter() -> Self {
            Self(unsafe { SetThreadDpiAwarenessContext(-4_isize as Handle) })
        }
    }
    impl Drop for PhysicalCoordinates {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { SetThreadDpiAwarenessContext(self.0) };
            }
        }
    }
    fn bounds(rect: Rect) -> Option<CaptureBounds> {
        let width = i64::from(rect.right) - i64::from(rect.left);
        let height = i64::from(rect.bottom) - i64::from(rect.top);
        if !(16..=i64::from(i32::MAX)).contains(&width)
            || !(16..=i64::from(i32::MAX)).contains(&height)
        {
            return None;
        }
        Some(CaptureBounds {
            x: rect.left,
            y: rect.top,
            width: width as u32,
            height: height as u32,
        })
    }
    unsafe extern "system" fn monitor_callback(
        monitor: Handle,
        _dc: Handle,
        _rect: *mut Rect,
        data: isize,
    ) -> i32 {
        let result = &mut *(data as *mut Vec<VisualTarget>);
        let mut info: MonitorInfo = zeroed();
        info.size = size_of::<MonitorInfo>() as u32;
        if GetMonitorInfoW(monitor, &mut info) == 0 {
            return 1;
        }
        let Some(bounds) = bounds(info.monitor) else {
            return 1;
        };
        let device = String::from_utf16_lossy(
            &info.device[..info.device.iter().position(|&c| c == 0).unwrap_or(32)],
        );
        let mut dpi_x = 96;
        let mut dpi_y = 96;
        if GetDpiForMonitor(monitor, 0, &mut dpi_x, &mut dpi_y) != 0 {
            dpi_x = 96;
        }
        let suffix = if info.flags & 1 != 0 {
            " · 主屏幕"
        } else {
            ""
        };
        let label = device.trim_start_matches("\\\\.\\").replace("DISPLAY", "");
        result.push(VisualTarget {
            id: format!("screen:{device}"),
            name: format!(
                "屏幕 {label} · {} × {}{suffix}",
                bounds.width, bounds.height
            ),
            kind: "screen".into(),
            bounds,
            scale_factor: f64::from(dpi_x.max(96)) / 96.0,
        });
        1
    }
    unsafe fn window_target(window: Hwnd) -> Option<VisualTarget> {
        if IsWindow(window) == 0 || IsWindowVisible(window) == 0 || IsIconic(window) != 0 {
            return None;
        }
        let mut pid = 0;
        GetWindowThreadProcessId(window, &mut pid);
        if pid == 0
            || (pid == GetCurrentProcessId() && !allow_fixture_window(window))
            || GetWindowLongPtrW(window, -20) & 0x80 != 0
        {
            return None;
        }
        let mut cloaked: u32 = 0;
        if DwmGetWindowAttribute(window, 14, (&mut cloaked as *mut u32).cast(), 4) == 0
            && cloaked != 0
        {
            return None;
        }
        let text_len = GetWindowTextLengthW(window);
        if !(1..=32767).contains(&text_len) {
            return None;
        }
        let mut title = vec![0; text_len as usize + 1];
        let length = GetWindowTextW(window, title.as_mut_ptr(), title.len() as i32);
        if length <= 0 {
            return None;
        }
        let title = String::from_utf16_lossy(&title[..length as usize]);
        if title.trim().is_empty() {
            return None;
        }
        let mut rect: Rect = zeroed();
        let mut origin = Point::default();
        if GetClientRect(window, &mut rect) == 0 || ClientToScreen(window, &mut origin) == 0 {
            return None;
        }
        let mut bounds = bounds(rect)?;
        bounds.x = origin.x;
        bounds.y = origin.y;
        Some(VisualTarget {
            id: format!("window:{}:{pid}", window as usize),
            name: title,
            kind: "window".into(),
            bounds,
            scale_factor: f64::from(GetDpiForWindow(window).max(96)) / 96.0,
        })
    }
    #[cfg(test)]
    static FIXTURE_WINDOWS: Mutex<Vec<usize>> = Mutex::new(Vec::new());
    fn allow_fixture_window(window: Hwnd) -> bool {
        #[cfg(test)]
        {
            FIXTURE_WINDOWS
                .lock()
                .map(|windows| windows.contains(&(window as usize)))
                .unwrap_or(false)
        }
        #[cfg(not(test))]
        {
            let _ = window;
            false
        }
    }
    unsafe extern "system" fn window_callback(window: Hwnd, data: isize) -> i32 {
        if let Some(target) = window_target(window) {
            (*(data as *mut Vec<VisualTarget>)).push(target);
        }
        1
    }
    fn screens() -> Result<Vec<VisualTarget>> {
        let mut targets = vec![];
        let ok = unsafe {
            EnumDisplayMonitors(
                null_mut(),
                null(),
                monitor_callback,
                (&mut targets as *mut Vec<VisualTarget>) as isize,
            )
        };
        if ok == 0 {
            return Err("无法读取屏幕列表，请检查当前桌面是否可访问。".into());
        }
        Ok(targets)
    }
    pub fn list_targets() -> Result<Vec<VisualTarget>> {
        let _physical = PhysicalCoordinates::enter();
        let mut targets = screens()?;
        let ok = unsafe {
            EnumWindows(
                window_callback,
                (&mut targets as *mut Vec<VisualTarget>) as isize,
            )
        };
        if ok == 0 {
            return Err("无法读取窗口列表，请刷新后重试。".into());
        }
        Ok(targets)
    }
    pub fn resolve_target(id: &str) -> Result<VisualTarget> {
        let _physical = PhysicalCoordinates::enter();
        if id.starts_with("screen:") {
            return screens()?
                .into_iter()
                .find(|target| target.id == id)
                .ok_or_else(|| "所选屏幕已断开，请重新选择录制目标。".into());
        }
        let (handle, pid) = parse_window_id(id)?;
        let target = unsafe { window_target(handle as Hwnd) }
            .ok_or("所选窗口已关闭、最小化或不可见，已暂停录制。请恢复窗口后继续。")?;
        let (_, actual_pid) = parse_window_id(&target.id)?;
        if actual_pid != pid {
            return Err("原录制窗口已关闭，请重新选择录制目标。".into());
        }
        Ok(target)
    }

    struct BorderWindows {
        handles: Vec<Hwnd>,
        class: Vec<u16>,
        instance: Handle,
        brush: Handle,
        registered: bool,
    }
    unsafe extern "system" fn border_proc(
        window: Hwnd,
        message: u32,
        wparam: usize,
        lparam: isize,
    ) -> isize {
        match message {
            0x0084 => -1, // HTTRANSPARENT
            0x0021 => 3,  // MA_NOACTIVATE
            0x0010 => 0,  // Only the recording worker closes its indicator.
            _ => DefWindowProcW(window, message, wparam, lparam),
        }
    }
    impl BorderWindows {
        fn create() -> Result<Self> {
            let mut version: SystemVersion = unsafe { zeroed() };
            version.size = size_of::<SystemVersion>() as u32;
            if unsafe { RtlGetVersion(&mut version) } != 0
                || version.major < 10
                || (version.major == 10 && version.build < 19041)
            {
                // Earlier builds accept the affinity value but replace it with black pixels.
                return Err("当前系统版本不支持将录制边框排除在录像外，请更新系统后重试。".into());
            }
            static NEXT_CLASS: AtomicU64 = AtomicU64::new(1);
            let name = format!(
                "OpenMediaRecordingBorder-{}-{}",
                unsafe { GetCurrentProcessId() },
                NEXT_CLASS.fetch_add(1, Ordering::Relaxed)
            );
            let mut owned = Self {
                handles: vec![],
                class: name.encode_utf16().chain([0]).collect(),
                instance: unsafe { GetModuleHandleW(null()) },
                brush: unsafe { CreateSolidBrush(0x004444ef) },
                registered: false,
            };
            if owned.brush.is_null() {
                return Err("无法创建录制红色边框。".into());
            }
            let class = WindowClass {
                style: 0,
                proc: Some(border_proc),
                class_extra: 0,
                window_extra: 0,
                instance: owned.instance,
                icon: null_mut(),
                cursor: null_mut(),
                background: owned.brush,
                menu_name: null(),
                class_name: owned.class.as_ptr(),
            };
            if unsafe { RegisterClassW(&class) } == 0 {
                return Err("无法注册录制红色边框。".into());
            }
            owned.registered = true;
            for _ in 0..4 {
                let window = unsafe {
                    CreateWindowExW(
                        0x00080000 | 0x00000020 | 0x00000008 | 0x00000080 | 0x08000000,
                        owned.class.as_ptr(),
                        owned.class.as_ptr(),
                        0x80000000,
                        0,
                        0,
                        1,
                        1,
                        null_mut(),
                        null_mut(),
                        owned.instance,
                        null_mut(),
                    )
                };
                if window.is_null() {
                    return Err("无法显示录制红色边框。".into());
                }
                owned.handles.push(window);
                if unsafe { SetLayeredWindowAttributes(window, 0, 255, 2) } == 0 {
                    return Err("无法设置录制边框。".into());
                }
                let mut affinity = 0;
                if unsafe { SetWindowDisplayAffinity(window, 0x11) } == 0
                    || unsafe { GetWindowDisplayAffinity(window, &mut affinity) } == 0
                    || affinity != 0x11
                {
                    return Err(
                        "当前桌面无法将录制边框排除在录像外，请检查系统显示设置后重试。".into(),
                    );
                }
            }
            Ok(owned)
        }
        fn place(&self, bounds: &CaptureBounds) -> Result<()> {
            for (window, rect) in self.handles.iter().zip(border_rects(bounds)) {
                if unsafe {
                    SetWindowPos(
                        *window,
                        -1_isize as Hwnd,
                        rect.x,
                        rect.y,
                        rect.width as i32,
                        rect.height as i32,
                        0x0010 | 0x0040,
                    )
                } == 0
                {
                    return Err("录制边框无法更新，已暂停录制。".into());
                }
            }
            Ok(())
        }
        fn hide(&self) {
            for window in &self.handles {
                unsafe { ShowWindow(*window, 0) };
            }
        }
    }
    impl Drop for BorderWindows {
        fn drop(&mut self) {
            for window in &self.handles {
                unsafe { DestroyWindow(*window) };
            }
            if self.registered {
                unsafe { UnregisterClassW(self.class.as_ptr(), self.instance) };
            }
            if !self.brush.is_null() {
                unsafe { DeleteObject(self.brush) };
            }
        }
    }

    pub struct BorderIndicator {
        stop: Sender<()>,
        worker: Option<JoinHandle<()>>,
        error: Arc<Mutex<Option<String>>>,
    }
    impl BorderIndicator {
        pub fn start(target: VisualTarget, region: Option<CaptureBounds>) -> Result<Self> {
            capture_bounds(&target, region.as_ref())?;
            let (stop, stopped) = mpsc::channel();
            let (ready, started) = mpsc::sync_channel(1);
            let error = Arc::new(Mutex::new(None));
            let worker_error = error.clone();
            let worker = thread::Builder::new()
                .name("recording-boundary".into())
                .spawn(move || {
                    let _physical = PhysicalCoordinates::enter();
                    let setup = (|| {
                        let current = resolve_target(&target.id)?;
                        let rect = tracked_bounds(&target, &current, region.as_ref())?;
                        let windows = BorderWindows::create()?;
                        windows.place(&rect)?;
                        Ok::<_, String>((windows, rect))
                    })();
                    let (windows, initial_rect) = match setup {
                        Ok(value) => value,
                        Err(reason) => {
                            let _ = ready.send(Err(reason));
                            return;
                        }
                    };
                    if ready.send(Ok(())).is_err() {
                        return;
                    }
                    follow_target(windows, target, region, initial_rect, stopped, worker_error);
                })
                .map_err(|e| format!("无法启动录制边框：{e}"))?;
            let mut indicator = Self {
                stop,
                worker: Some(worker),
                error,
            };
            match started.recv_timeout(Duration::from_secs(3)) {
                Ok(Ok(())) => Ok(indicator),
                Ok(Err(reason)) => {
                    indicator.shutdown();
                    Err(reason)
                }
                Err(_) => {
                    indicator.shutdown();
                    Err("录制边框启动失败，请重试。".into())
                }
            }
        }
        pub fn error(&self) -> Option<String> {
            self.error.lock().ok().and_then(|error| error.clone())
        }
        fn shutdown(&mut self) {
            let _ = self.stop.send(());
            if let Some(worker) = self.worker.take() {
                let _ = worker.join();
            }
        }
    }
    impl Drop for BorderIndicator {
        fn drop(&mut self) {
            self.shutdown();
        }
    }
    fn follow_target(
        windows: BorderWindows,
        target: VisualTarget,
        region: Option<CaptureBounds>,
        mut last_bounds: CaptureBounds,
        stopped: Receiver<()>,
        error: Arc<Mutex<Option<String>>>,
    ) {
        loop {
            let mut message: Message = unsafe { zeroed() };
            unsafe {
                while PeekMessageW(&mut message, null_mut(), 0, 0, 1) != 0 {
                    TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
            }
            match stopped.recv_timeout(Duration::from_millis(80)) {
                Ok(()) | Err(RecvTimeoutError::Disconnected) => return,
                Err(RecvTimeoutError::Timeout) => {}
            }
            let current = resolve_target(&target.id)
                .and_then(|current| tracked_bounds(&target, &current, region.as_ref()));
            let outcome = current.and_then(|rect| {
                if rect != last_bounds {
                    windows.place(&rect)?;
                    last_bounds = rect;
                }
                Ok(())
            });
            if let Err(reason) = outcome {
                windows.hide();
                if let Ok(mut error) = error.lock() {
                    *error = Some(reason);
                }
                return;
            }
        }
    }

    #[cfg(test)]
    mod windows_tests {
        use super::*;
        use std::time::Instant;

        #[link(name = "user32")]
        extern "system" {
            fn GetDC(window: Hwnd) -> Handle;
            fn ReleaseDC(window: Hwnd, dc: Handle) -> i32;
            fn GetForegroundWindow() -> Hwnd;
        }
        #[link(name = "gdi32")]
        extern "system" {
            fn CreateCompatibleDC(dc: Handle) -> Handle;
            fn CreateCompatibleBitmap(dc: Handle, width: i32, height: i32) -> Handle;
            fn SelectObject(dc: Handle, object: Handle) -> Handle;
            fn BitBlt(
                destination: Handle,
                x: i32,
                y: i32,
                width: i32,
                height: i32,
                source: Handle,
                source_x: i32,
                source_y: i32,
                operation: u32,
            ) -> i32;
            fn GetPixel(dc: Handle, x: i32, y: i32) -> u32;
            fn DeleteDC(dc: Handle) -> i32;
        }

        enum FixtureAction {
            Move,
            Resize,
            Minimize,
            Restore,
            Close,
        }
        struct Fixture {
            hwnd: usize,
            actions: Sender<(FixtureAction, Sender<()>)>,
            worker: Option<JoinHandle<()>>,
        }
        impl Fixture {
            fn start() -> Self {
                let (actions, commands) = mpsc::channel::<(FixtureAction, Sender<()>)>();
                let (ready, started) = mpsc::sync_channel(1);
                let worker = thread::spawn(move || {
                    let _physical = PhysicalCoordinates::enter();
                    let mut owned = BorderWindows {
                        handles: vec![],
                        class: "OpenMediaCaptureTestWindow"
                            .encode_utf16()
                            .chain([0])
                            .collect(),
                        instance: unsafe { GetModuleHandleW(null()) },
                        brush: unsafe { CreateSolidBrush(0x0020a040) },
                        registered: false,
                    };
                    let class = WindowClass {
                        style: 0,
                        proc: Some(border_proc),
                        class_extra: 0,
                        window_extra: 0,
                        instance: owned.instance,
                        icon: null_mut(),
                        cursor: null_mut(),
                        background: owned.brush,
                        menu_name: null(),
                        class_name: owned.class.as_ptr(),
                    };
                    assert_ne!(unsafe { RegisterClassW(&class) }, 0);
                    owned.registered = true;
                    let window = unsafe {
                        CreateWindowExW(
                            0x00000008 | 0x08000000,
                            owned.class.as_ptr(),
                            owned.class.as_ptr(),
                            0x80000000,
                            100,
                            100,
                            360,
                            240,
                            null_mut(),
                            null_mut(),
                            owned.instance,
                            null_mut(),
                        )
                    };
                    assert!(!window.is_null());
                    owned.handles.push(window);
                    FIXTURE_WINDOWS.lock().unwrap().push(window as usize);
                    unsafe { ShowWindow(window, 4) };
                    ready.send(window as usize).unwrap();
                    loop {
                        let mut message: Message = unsafe { zeroed() };
                        unsafe {
                            while PeekMessageW(&mut message, null_mut(), 0, 0, 1) != 0 {
                                TranslateMessage(&message);
                                DispatchMessageW(&message);
                            }
                        }
                        match commands.recv_timeout(Duration::from_millis(10)) {
                            Ok((action, acknowledged)) => {
                                let close = matches!(action, FixtureAction::Close);
                                unsafe {
                                    match action {
                                        FixtureAction::Move => {
                                            SetWindowPos(
                                                window,
                                                null_mut(),
                                                180,
                                                140,
                                                360,
                                                240,
                                                0x0010 | 0x0004,
                                            );
                                        }
                                        FixtureAction::Minimize => {
                                            ShowWindow(window, 6);
                                        }
                                        FixtureAction::Restore => {
                                            ShowWindow(window, 9);
                                        }
                                        FixtureAction::Resize => {
                                            SetWindowPos(
                                                window,
                                                null_mut(),
                                                180,
                                                140,
                                                400,
                                                260,
                                                0x0010 | 0x0004,
                                            );
                                        }
                                        FixtureAction::Close => {}
                                    }
                                }
                                let _ = acknowledged.send(());
                                if close {
                                    break;
                                }
                            }
                            Err(RecvTimeoutError::Disconnected) => break,
                            Err(RecvTimeoutError::Timeout) => {}
                        }
                    }
                    FIXTURE_WINDOWS
                        .lock()
                        .unwrap()
                        .retain(|&handle| handle != window as usize);
                });
                Self {
                    hwnd: started
                        .recv_timeout(Duration::from_secs(3))
                        .expect("test window starts"),
                    actions,
                    worker: Some(worker),
                }
            }
            fn action(&self, action: FixtureAction) {
                let (sent, received) = mpsc::channel();
                self.actions.send((action, sent)).unwrap();
                received.recv_timeout(Duration::from_secs(3)).unwrap();
            }
        }
        impl Drop for Fixture {
            fn drop(&mut self) {
                let (sent, _) = mpsc::channel();
                let _ = self.actions.send((FixtureAction::Close, sent));
                if let Some(worker) = self.worker.take() {
                    let _ = worker.join();
                }
            }
        }
        fn wait_for(mut condition: impl FnMut() -> bool) {
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                if condition() {
                    return;
                }
                assert!(
                    Instant::now() < deadline,
                    "native recording state did not update"
                );
                thread::sleep(Duration::from_millis(20));
            }
        }
        fn overlay_windows() -> Vec<usize> {
            unsafe extern "system" fn collect(window: Hwnd, data: isize) -> i32 {
                let mut text = [0_u16; 128];
                let length = GetWindowTextW(window, text.as_mut_ptr(), text.len() as i32);
                if length > 0
                    && String::from_utf16_lossy(&text[..length as usize])
                        .starts_with("OpenMediaRecordingBorder-")
                {
                    (*(data as *mut Vec<usize>)).push(window as usize);
                }
                1
            }
            let mut windows = vec![];
            unsafe { EnumWindows(collect, (&mut windows as *mut Vec<usize>) as isize) };
            windows
        }
        /// Sample the same desktop BitBlt path used by the recording engine.
        fn captured_pixel(x: i32, y: i32) -> u32 {
            unsafe {
                let desktop = GetDC(null_mut());
                assert!(!desktop.is_null());
                let memory = CreateCompatibleDC(desktop);
                let bitmap = CreateCompatibleBitmap(desktop, 1, 1);
                let original = SelectObject(memory, bitmap);
                let copied = BitBlt(memory, 0, 0, 1, 1, desktop, x, y, 0x00CC0020 | 0x40000000);
                let color = GetPixel(memory, 0, 0);
                SelectObject(memory, original);
                DeleteObject(bitmap);
                DeleteDC(memory);
                ReleaseDC(null_mut(), desktop);
                assert_ne!(copied, 0, "desktop capture uses the real capture path");
                color
            }
        }
        fn assert_recorded_pixels(target: &VisualTarget) {
            use crate::engine::{process, Runtime};
            let runtime = Runtime::discover(None, None).expect("packaged media runtime");
            let root = tempfile::tempdir().unwrap();
            for mode in ["window", "screen-region"] {
                let image = root.path().join(format!("{mode}.png"));
                let mut command = process(&runtime.encoder);
                command.args([
                    "-hide_banner",
                    "-nostdin",
                    "-loglevel",
                    "error",
                    "-y",
                    "-f",
                    "gdigrab",
                    "-framerate",
                    "10",
                    "-draw_mouse",
                    "0",
                ]);
                if mode == "window" {
                    command.args([
                        "-i",
                        &format!("hwnd={}", super::super::window_handle(&target.id).unwrap()),
                    ]);
                } else {
                    command.args([
                        "-offset_x",
                        &target.bounds.x.to_string(),
                        "-offset_y",
                        &target.bounds.y.to_string(),
                        "-video_size",
                        &format!("{}x{}", target.bounds.width, target.bounds.height),
                        "-i",
                        "desktop",
                    ]);
                }
                let errors = root.path().join(format!("{mode}.log"));
                let mut child = command
                    .args(["-frames:v", "1"])
                    .arg(&image)
                    .stdout(std::process::Stdio::null())
                    .stderr(std::fs::File::create(&errors).unwrap())
                    .spawn()
                    .unwrap();
                let deadline = Instant::now() + Duration::from_secs(15);
                let status = loop {
                    if let Some(status) = child.try_wait().unwrap() {
                        break status;
                    }
                    if Instant::now() >= deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        panic!(
                            "{mode} capture timed out: {}",
                            std::fs::read_to_string(&errors).unwrap_or_default()
                        );
                    }
                    thread::sleep(Duration::from_millis(30));
                };
                assert!(
                    status.success(),
                    "{mode} capture failed: {}",
                    std::fs::read_to_string(&errors).unwrap_or_default()
                );
                let probe = process(&runtime.probe)
                    .args(["-v", "error", "-show_streams", "-of", "json"])
                    .arg(&image)
                    .output()
                    .unwrap();
                let metadata: serde_json::Value = serde_json::from_slice(&probe.stdout).unwrap();
                assert_eq!(metadata["streams"][0]["width"], target.bounds.width);
                assert_eq!(metadata["streams"][0]["height"], target.bounds.height);
                let pixels = process(&runtime.encoder)
                    .args(["-hide_banner", "-loglevel", "error", "-i"])
                    .arg(&image)
                    .args([
                        "-frames:v",
                        "1",
                        "-pix_fmt",
                        "rgb24",
                        "-f",
                        "rawvideo",
                        "pipe:1",
                    ])
                    .output()
                    .unwrap();
                assert!(pixels.status.success());
                for (x, y) in [(1, 1), (358, 1), (1, 238), (358, 238), (180, 120)] {
                    let offset = ((y * target.bounds.width + x) * 3) as usize;
                    assert_eq!(
                        &pixels.stdout[offset..offset + 3],
                        &[64, 160, 32],
                        "{mode} frame has unexpected border/black pixels at {x},{y}"
                    );
                }
            }
        }
        #[test]
        fn real_window_indicator_tracks_excludes_pixels_and_cleans_up() {
            let _physical = PhysicalCoordinates::enter();
            let fixture = Fixture::start();
            let id = format!("window:{}:{}", fixture.hwnd, unsafe {
                GetCurrentProcessId()
            });
            let selected = resolve_target(&id).unwrap();
            assert!(list_targets().unwrap().iter().any(|target| target.id == id));
            let baseline_foreground = unsafe { GetForegroundWindow() };
            wait_for(|| captured_pixel(selected.bounds.x + 1, selected.bounds.y + 1) == 0x0020a040);
            let indicator = BorderIndicator::start(selected.clone(), None).unwrap();
            wait_for(|| overlay_windows().len() == 4);
            thread::sleep(Duration::from_millis(160));
            assert_eq!(
                unsafe { GetForegroundWindow() },
                baseline_foreground,
                "indicator must not activate"
            );
            for hwnd in overlay_windows() {
                let style = unsafe { GetWindowLongPtrW(hwnd as Hwnd, -20) };
                assert_eq!(
                    style & 0x08000020,
                    0x08000020,
                    "indicator stays click-through and non-activating"
                );
            }
            for (x, y) in [(1, 1), (358, 1), (1, 238), (358, 238)] {
                assert_eq!(
                    captured_pixel(selected.bounds.x + x, selected.bounds.y + y),
                    0x0020a040,
                    "red border must be omitted rather than burned in or replaced with black"
                );
            }
            assert_recorded_pixels(&selected);
            fixture.action(FixtureAction::Move);
            wait_for(|| resolve_target(&id).unwrap().bounds.x == 180);
            thread::sleep(Duration::from_millis(160));
            assert!(indicator.error().is_none());
            assert_eq!(captured_pixel(181, 141), 0x0020a040);
            fixture.action(FixtureAction::Minimize);
            wait_for(|| indicator.error().is_some());
            wait_for(|| overlay_windows().is_empty());
            assert!(resolve_target(&id).is_err());
            drop(indicator);
            fixture.action(FixtureAction::Restore);
            wait_for(|| resolve_target(&id).is_ok());
            let next = BorderIndicator::start(resolve_target(&id).unwrap(), None).unwrap();
            wait_for(|| overlay_windows().len() == 4);
            drop(next);
            assert!(
                overlay_windows().is_empty(),
                "dropping the indicator joins its window cleanup"
            );
            let resized_indicator =
                BorderIndicator::start(resolve_target(&id).unwrap(), None).unwrap();
            fixture.action(FixtureAction::Resize);
            wait_for(|| resized_indicator.error().is_some());
            wait_for(|| overlay_windows().is_empty());
            assert_eq!(resolve_target(&id).unwrap().bounds.width, 400);
            drop(resized_indicator);
            let final_indicator =
                BorderIndicator::start(resolve_target(&id).unwrap(), None).unwrap();
            drop(fixture);
            wait_for(|| final_indicator.error().is_some());
            assert!(resolve_target(&id).is_err());
            wait_for(|| overlay_windows().is_empty());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(kind: &str, x: i32, y: i32) -> VisualTarget {
        VisualTarget {
            id: format!("{kind}:selected"),
            name: "录制目标".into(),
            kind: kind.into(),
            bounds: CaptureBounds {
                x,
                y,
                width: 1920,
                height: 1080,
            },
            scale_factor: 1.0,
        }
    }

    #[test]
    fn source_region_respects_negative_monitor_coordinates() {
        let selected = target("screen", -1920, -200);
        let region = CaptureBounds {
            x: 200,
            y: 100,
            width: 1280,
            height: 720,
        };
        assert_eq!(
            capture_bounds(&selected, Some(&region)).unwrap(),
            CaptureBounds {
                x: -1720,
                y: -100,
                width: 1280,
                height: 720,
            }
        );
        assert_eq!(capture_bounds(&selected, None).unwrap(), selected.bounds);
    }

    #[test]
    fn rejects_out_of_bounds_regions_and_window_cropping() {
        let selected = target("screen", 0, 0);
        for region in [
            CaptureBounds {
                x: -1,
                y: 0,
                width: 16,
                height: 16,
            },
            CaptureBounds {
                x: 1910,
                y: 0,
                width: 16,
                height: 16,
            },
            CaptureBounds {
                x: 0,
                y: 1070,
                width: 16,
                height: 16,
            },
            CaptureBounds {
                x: i32::MAX,
                y: 0,
                width: u32::MAX,
                height: 16,
            },
            CaptureBounds {
                x: 0,
                y: 0,
                width: 1,
                height: 16,
            },
        ] {
            assert!(capture_bounds(&selected, Some(&region)).is_err());
        }
        assert!(capture_bounds(&target("window", 0, 0), Some(&selected.bounds)).is_err());
    }

    #[test]
    fn target_motion_preserves_window_capture_but_screen_layout_changes_stop() {
        let original = target("window", 10, 30);
        let moved = target("window", -1200, 100);
        assert_eq!(
            tracked_bounds(&original, &moved, None).unwrap(),
            moved.bounds
        );
        let mut resized = moved.clone();
        resized.bounds.width += 1;
        assert!(tracked_bounds(&original, &resized, None).is_err());
        assert!(tracked_bounds(&target("screen", 0, 0), &target("screen", 100, 0), None).is_err());
        let mut replacement = original.clone();
        replacement.id = "window:different".into();
        assert!(tracked_bounds(&original, &replacement, None).is_err());
    }

    #[test]
    fn handles_are_strict_and_include_process_identity() {
        assert_eq!(
            parse_window_id("window:123456789:42").unwrap(),
            (123456789, 42)
        );
        for id in [
            "window:123",
            "window:-1:1",
            "window:0:42",
            "window:42:0",
            "window:12:2:3",
            "window: 12:42",
            "screen:123:42",
        ] {
            assert!(parse_window_id(id).is_err(), "accepted {id}");
        }
    }

    #[test]
    fn indicator_edges_match_full_capture_rectangle() {
        let bounds = target("screen", -1920, -100).bounds;
        let [top, bottom, left, right] = border_rects(&bounds);
        assert_eq!(
            (top.x, top.y, top.width, top.height),
            (-1920, -100, 1920, 3)
        );
        assert_eq!(
            (bottom.x, bottom.y, bottom.width, bottom.height),
            (-1920, 977, 1920, 3)
        );
        assert_eq!(
            (left.x, left.y, left.width, left.height),
            (-1920, -100, 3, 1080)
        );
        assert_eq!(
            (right.x, right.y, right.width, right.height),
            (-3, -100, 3, 1080)
        );
    }
}
