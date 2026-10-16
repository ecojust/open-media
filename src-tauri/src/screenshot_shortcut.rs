//! System-wide screenshot shortcut. Registration never starts capture itself.

use std::sync::Arc;

type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Key {
    Character(u8),
    Function(u8),
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Binding {
    control: bool,
    alt: bool,
    shift: bool,
    meta: bool,
    key: Key,
    label: String,
}

impl Binding {
    fn parse(input: &str) -> Result<Self> {
        Self::parse_for_platform(input, cfg!(target_os = "macos"))
    }

    fn parse_for_platform(input: &str, mac: bool) -> Result<Self> {
        let mut control = false;
        let mut alt = false;
        let mut shift = false;
        let mut meta = false;
        let mut key = None;
        if input.len() > 96 {
            return Err("截屏快捷键过长，请重新设置。".into());
        }
        for part in input.split('+') {
            let token = part.trim().to_ascii_uppercase();
            let modifier = match token.as_str() {
                "CTRL" | "CONTROL" => Some(&mut control),
                "ALT" | "OPTION" => Some(&mut alt),
                "SHIFT" => Some(&mut shift),
                "META" | "CMD" | "COMMAND" | "SUPER" => Some(&mut meta),
                "COMMANDORCONTROL" => Some(if mac { &mut meta } else { &mut control }),
                _ => None,
            };
            if let Some(modifier) = modifier {
                if *modifier {
                    return Err("截屏快捷键中包含重复的修饰键。".into());
                }
                *modifier = true;
                continue;
            }
            let parsed = if token.len() == 1 && token.as_bytes()[0].is_ascii_alphanumeric() {
                Some(Key::Character(token.as_bytes()[0]))
            } else {
                token
                    .strip_prefix('F')
                    .filter(|number| !number.starts_with('0'))
                    .and_then(|number| number.parse::<u8>().ok())
                    .filter(|number| (1..=20).contains(number))
                    .map(Key::Function)
            };
            let Some(parsed) = parsed else {
                return Err("快捷键支持字母、数字或 F1–F20，并搭配 Ctrl、Alt、Shift 或 Cmd。".into());
            };
            if key.replace(parsed).is_some() {
                return Err("截屏快捷键只能包含一个字母、数字或功能键。".into());
            }
        }
        if !(control || alt || meta) {
            return Err("截屏快捷键需包含 Ctrl、Alt 或 Cmd，避免影响正常输入。".into());
        }
        let key = key.ok_or("请选择一个字母、数字或 F1–F20 功能键。")?;
        let mut parts = Vec::new();
        if meta {
            parts.push(if mac { "Cmd" } else { "Meta" }.to_owned());
        }
        if control {
            parts.push("Ctrl".to_owned());
        }
        if alt {
            parts.push("Alt".to_owned());
        }
        if shift {
            parts.push("Shift".to_owned());
        }
        parts.push(match key {
            Key::Character(value) => (value as char).to_string(),
            Key::Function(number) => format!("F{number}"),
        });
        Ok(Self {
            control,
            alt,
            shift,
            meta,
            key,
            label: parts.join("+"),
        })
    }
}

/// Cloneable application state; constructing it does not register a shortcut.
#[derive(Clone)]
pub struct ShortcutManager {
    platform: Arc<platform::Manager>,
}

impl ShortcutManager {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self {
            platform: Arc::new(platform::Manager::new(app)),
        }
    }

    /// A failed replacement preserves the previously registered shortcut.
    pub async fn configure(&self, shortcut: Option<String>) -> Result<Option<String>> {
        let binding = shortcut.as_deref().map(Binding::parse).transpose()?;
        let platform = self.platform.clone();
        tauri::async_runtime::spawn_blocking(move || platform.configure(binding))
            .await
            .map_err(|error| format!("截屏快捷键设置未完成：{error}"))?
    }

    /// Stops accepting registrations and releases system resources on their owner thread.
    pub fn shutdown(&self) {
        self.platform.shutdown();
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{Binding, Key, Result};
    use std::{
        ffi::c_void,
        ptr::null_mut,
        sync::{
            atomic::{AtomicBool, AtomicU32, Ordering},
            mpsc, Arc, Mutex,
        },
    };
    use tauri::Emitter;

    const SIGNATURE: u32 = u32::from_be_bytes(*b"OMSS");
    const KEYBOARD: u32 = u32::from_be_bytes(*b"keyb");
    const HOT_KEY_PRESSED: u32 = 5;
    const HOT_KEY_RELEASED: u32 = 6;
    const EXCLUSIVE_HOT_KEY: u32 = 1;

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct HotKeyId {
        signature: u32,
        id: u32,
    }

    #[repr(C)]
    struct EventType {
        class: u32,
        kind: u32,
    }

    type EventCallback = unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void) -> i32;

    #[link(name = "Carbon", kind = "framework")]
    extern "C" {
        fn GetApplicationEventTarget() -> *mut c_void;
        fn InstallEventHandler(
            target: *mut c_void,
            handler: EventCallback,
            count: usize,
            types: *const EventType,
            context: *mut c_void,
            result: *mut *mut c_void,
        ) -> i32;
        fn RemoveEventHandler(handler: *mut c_void) -> i32;
        fn RegisterEventHotKey(
            key: u32,
            modifiers: u32,
            id: HotKeyId,
            target: *mut c_void,
            options: u32,
            result: *mut *mut c_void,
        ) -> i32;
        fn UnregisterEventHotKey(hot_key: *mut c_void) -> i32;
        fn GetEventParameter(
            event: *mut c_void,
            name: u32,
            desired_type: u32,
            actual_type: *mut u32,
            size: usize,
            actual_size: *mut usize,
            data: *mut c_void,
        ) -> i32;
        fn GetEventKind(event: *mut c_void) -> u32;
    }

    struct CallbackContext {
        app: tauri::AppHandle,
        active_id: AtomicU32,
        pressed: AtomicBool,
    }

    // Carbon owns no Rust data. This allocation stays alive until its handler is removed.
    unsafe extern "C" fn hot_key_event(
        _next: *mut c_void,
        event: *mut c_void,
        context: *mut c_void,
    ) -> i32 {
        if context.is_null() || event.is_null() {
            return -9874;
        }
        let mut id = HotKeyId::default();
        let status = GetEventParameter(
            event,
            u32::from_be_bytes(*b"----"),
            u32::from_be_bytes(*b"hkid"),
            null_mut(),
            std::mem::size_of::<HotKeyId>(),
            null_mut(),
            &mut id as *mut HotKeyId as *mut c_void,
        );
        let context = &*(context as *const CallbackContext);
        if status != 0
            || id.signature != SIGNATURE
            || id.id != context.active_id.load(Ordering::Acquire)
        {
            return -9874;
        }
        match GetEventKind(event) {
            HOT_KEY_PRESSED => {
                if !context.pressed.swap(true, Ordering::AcqRel) {
                    let _ = context.app.emit_to("main", "screenshot-requested", ());
                }
            }
            HOT_KEY_RELEASED => context.pressed.store(false, Ordering::Release),
            _ => return -9874,
        }
        0
    }

    struct Registration {
        binding: Binding,
        reference: usize,
    }

    #[derive(Default)]
    struct MainThreadState {
        // These opaque addresses are read and released only on the application thread.
        handler: usize,
        context: usize,
        current: Option<Registration>,
        next_id: u32,
    }

    impl MainThreadState {
        fn install_handler(&mut self, app: &tauri::AppHandle) -> Result<()> {
            if self.handler != 0 {
                return Ok(());
            }
            let context = Box::into_raw(Box::new(CallbackContext {
                app: app.clone(),
                active_id: AtomicU32::new(0),
                pressed: AtomicBool::new(false),
            }));
            let types = [
                EventType { class: KEYBOARD, kind: HOT_KEY_PRESSED },
                EventType { class: KEYBOARD, kind: HOT_KEY_RELEASED },
            ];
            let mut handler = null_mut();
            let result = unsafe {
                InstallEventHandler(
                    GetApplicationEventTarget(),
                    hot_key_event,
                    types.len(),
                    types.as_ptr(),
                    context as *mut c_void,
                    &mut handler,
                )
            };
            if result != 0 {
                unsafe { drop(Box::from_raw(context)); }
                return Err(format!("无法启用截屏快捷键监听（系统代码 {result}）。"));
            }
            self.handler = handler as usize;
            self.context = context as usize;
            Ok(())
        }

        fn configure(&mut self, app: &tauri::AppHandle, binding: Option<Binding>) -> Result<Option<String>> {
            if self.current.as_ref().map(|value| &value.binding) == binding.as_ref() {
                return Ok(binding.map(|value| value.label));
            }
            let Some(binding) = binding else {
                if let Some(current) = &self.current {
                    let result = unsafe { UnregisterEventHotKey(current.reference as *mut c_void) };
                    if result != 0 {
                        return Err(format!("无法停用截屏快捷键（系统代码 {result}）。"));
                    }
                }
                self.current = None;
                self.update_context(0);
                return Ok(None);
            };
            self.install_handler(app)?;
            self.next_id = self.next_id.wrapping_add(1).max(1);
            let id = self.next_id;
            let mut reference = null_mut();
            let result = unsafe {
                RegisterEventHotKey(
                    virtual_key(binding.key),
                    modifiers(&binding),
                    HotKeyId { signature: SIGNATURE, id },
                    GetApplicationEventTarget(),
                    EXCLUSIVE_HOT_KEY,
                    &mut reference,
                )
            };
            if result != 0 {
                return Err(format!(
                    "无法注册 {}，可能已被系统或其他应用占用；原快捷键保持不变（系统代码 {result}）。",
                    binding.label
                ));
            }
            if let Some(current) = &self.current {
                let result = unsafe { UnregisterEventHotKey(current.reference as *mut c_void) };
                if result != 0 {
                    unsafe { UnregisterEventHotKey(reference); }
                    return Err(format!("无法替换截屏快捷键，原快捷键保持不变（系统代码 {result}）。"));
                }
            }
            let label = binding.label.clone();
            self.current = Some(Registration { binding, reference: reference as usize });
            self.update_context(id);
            Ok(Some(label))
        }

        fn update_context(&self, id: u32) {
            if self.context != 0 {
                let context = unsafe { &*(self.context as *const CallbackContext) };
                context.active_id.store(id, Ordering::Release);
                context.pressed.store(false, Ordering::Release);
            }
        }

        fn shutdown(&mut self) {
            self.update_context(0);
            if let Some(current) = self.current.take() {
                unsafe { UnregisterEventHotKey(current.reference as *mut c_void); }
            }
            if self.handler != 0 {
                let result = unsafe { RemoveEventHandler(self.handler as *mut c_void) };
                // If removal fails, leave the inert callback allocated until process exit.
                if result == 0 {
                    unsafe { drop(Box::from_raw(self.context as *mut CallbackContext)); }
                }
                self.handler = 0;
                self.context = 0;
            }
        }
    }

    fn modifiers(binding: &Binding) -> u32 {
        (if binding.meta { 1 << 8 } else { 0 })
            | (if binding.shift { 1 << 9 } else { 0 })
            | (if binding.alt { 1 << 11 } else { 0 })
            | (if binding.control { 1 << 12 } else { 0 })
    }

    fn virtual_key(key: Key) -> u32 {
        match key {
            Key::Character(value) => match value {
                b'A' => 0, b'S' => 1, b'D' => 2, b'F' => 3, b'H' => 4, b'G' => 5,
                b'Z' => 6, b'X' => 7, b'C' => 8, b'V' => 9, b'B' => 11,
                b'Q' => 12, b'W' => 13, b'E' => 14, b'R' => 15, b'Y' => 16, b'T' => 17,
                b'1' => 18, b'2' => 19, b'3' => 20, b'4' => 21, b'6' => 22, b'5' => 23,
                b'9' => 25, b'7' => 26, b'8' => 28, b'0' => 29, b'O' => 31, b'U' => 32,
                b'I' => 34, b'P' => 35, b'L' => 37, b'J' => 38, b'K' => 40, b'N' => 45,
                b'M' => 46,
                _ => unreachable!("validated shortcut character"),
            },
            Key::Function(number) => [
                122, 120, 99, 118, 96, 97, 98, 100, 101, 109,
                103, 111, 105, 107, 113, 106, 64, 79, 80, 90,
            ][usize::from(number - 1)],
        }
    }

    pub struct Manager {
        app: tauri::AppHandle,
        state: Arc<Mutex<MainThreadState>>,
        closed: Arc<AtomicBool>,
    }

    impl Manager {
        pub fn new(app: tauri::AppHandle) -> Self {
            Self {
                app,
                state: Arc::new(Mutex::new(MainThreadState::default())),
                closed: Arc::new(AtomicBool::new(false)),
            }
        }

        pub fn configure(&self, binding: Option<Binding>) -> Result<Option<String>> {
            if self.closed.load(Ordering::Acquire) {
                return Err("应用正在退出，无法设置截屏快捷键。".into());
            }
            let (sender, receiver) = mpsc::sync_channel(1);
            let state = self.state.clone();
            let closed = self.closed.clone();
            let app = self.app.clone();
            self.app.run_on_main_thread(move || {
                let result = if closed.load(Ordering::Acquire) {
                    Err("应用正在退出，无法设置截屏快捷键。".into())
                } else {
                    state.lock()
                        .map_err(|_| "截屏快捷键状态不可用。".to_owned())
                        .and_then(|mut state| state.configure(&app, binding))
                };
                let _ = sender.send(result);
            }).map_err(|error| format!("无法设置截屏快捷键：{error}"))?;
            receiver.recv().map_err(|_| "截屏快捷键设置已中止。".to_owned())?
        }

        pub fn shutdown(&self) {
            if self.closed.swap(true, Ordering::AcqRel) {
                return;
            }
            let state = self.state.clone();
            let _ = self.app.run_on_main_thread(move || {
                if let Ok(mut state) = state.lock() {
                    state.shutdown();
                }
            });
        }
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{Binding, Key, Result};
    use std::{
        collections::HashMap,
        ffi::c_void,
        ptr::null_mut,
        sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering},
            mpsc::{self, Sender}, Arc, Mutex,
        },
        thread,
    };
    use tauri::Emitter;

    const REQUEST: u32 = 0x8000 + 37;
    const HOT_KEY: u32 = 0x0312;

    #[repr(C)]
    #[derive(Default)]
    struct Point { x: i32, y: i32 }

    #[repr(C)]
    struct Message {
        window: *mut c_void,
        message: u32,
        wparam: usize,
        lparam: isize,
        time: u32,
        point: Point,
        private: u32,
    }

    #[link(name = "user32")]
    extern "system" {
        fn RegisterHotKey(window: *mut c_void, id: i32, modifiers: u32, key: u32) -> i32;
        fn UnregisterHotKey(window: *mut c_void, id: i32) -> i32;
        fn GetMessageW(message: *mut Message, window: *mut c_void, min: u32, max: u32) -> i32;
        fn PeekMessageW(message: *mut Message, window: *mut c_void, min: u32, max: u32, remove: u32) -> i32;
        fn PostThreadMessageW(thread: u32, message: u32, wparam: usize, lparam: isize) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentThreadId() -> u32;
        fn GetLastError() -> u32;
    }

    enum Request {
        Configure(Option<Binding>, Sender<Result<Option<String>>>),
        Stop,
    }

    struct Registration { binding: Binding, id: i32 }

    struct Worker {
        pending: Arc<Mutex<HashMap<usize, Request>>>,
        alive: Arc<AtomicBool>,
        next_request: AtomicUsize,
        thread_id: u32,
    }

    impl Worker {
        fn start(app: tauri::AppHandle) -> Result<Self> {
            let pending = Arc::new(Mutex::new(HashMap::new()));
            let worker_pending = pending.clone();
            let alive = Arc::new(AtomicBool::new(true));
            let worker_alive = alive.clone();
            let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
            thread::Builder::new().name("screenshot-shortcut".into()).spawn(move || {
                let mut message: Message = unsafe { std::mem::zeroed() };
                // Create the thread message queue before accepting configuration requests.
                unsafe { PeekMessageW(&mut message, null_mut(), 0, 0, 0); }
                let id = unsafe { GetCurrentThreadId() };
                if ready_sender.send(id).is_err() {
                    worker_alive.store(false, Ordering::Release);
                    return;
                }
                Self::run(app, worker_pending, worker_alive, &mut message);
            }).map_err(|error| format!("无法启动截屏快捷键监听：{error}"))?;
            let thread_id = ready_receiver.recv().map_err(|_| "截屏快捷键监听未启动。")?;
            Ok(Self { pending, alive, next_request: AtomicUsize::new(1), thread_id })
        }

        fn run(app: tauri::AppHandle, pending: Arc<Mutex<HashMap<usize, Request>>>, alive: Arc<AtomicBool>, message: &mut Message) {
            let mut current: Option<Registration> = None;
            let mut next_id = 1;
            loop {
                if unsafe { GetMessageW(message, null_mut(), 0, 0) } <= 0 {
                    break;
                }
                if message.message == HOT_KEY {
                    if current.as_ref().is_some_and(|value| value.id as usize == message.wparam) {
                        let _ = app.emit_to("main", "screenshot-requested", ());
                    }
                } else if message.message == REQUEST {
                    let request = pending.lock().ok().and_then(|mut requests| requests.remove(&message.wparam));
                    if let Some(request) = request {
                        match request {
                            Request::Configure(binding, reply) => {
                                let result = configure_registration(&mut current, &mut next_id, binding);
                                let _ = reply.send(result);
                            }
                            Request::Stop => break,
                        }
                    }
                }
            }
            if let Some(current) = current {
                unsafe { UnregisterHotKey(null_mut(), current.id); }
            }
            if let Ok(mut requests) = pending.lock() {
                alive.store(false, Ordering::Release);
                requests.clear();
            }
        }

        fn send(&self, request: Request) -> Result<()> {
            let id = self.next_request.fetch_add(1, Ordering::Relaxed);
            {
                let mut requests = self.pending.lock().map_err(|_| "截屏快捷键状态不可用。")?;
                if !self.alive.load(Ordering::Acquire) {
                    return Err("截屏快捷键监听已停止。".into());
                }
                requests.insert(id, request);
            }
            if unsafe { PostThreadMessageW(self.thread_id, REQUEST, id, 0) } == 0 {
                let error = unsafe { GetLastError() };
                // Process only requests with successfully posted messages. A failed post
                // must never apply the new binding during a later configuration request.
                if let Ok(mut requests) = self.pending.lock() { requests.remove(&id); }
                return Err(format!("无法通知截屏快捷键监听（系统代码 {error}）。"));
            }
            Ok(())
        }
    }

    impl Drop for Worker {
        fn drop(&mut self) { let _ = self.send(Request::Stop); }
    }

    fn configure_registration(current: &mut Option<Registration>, next_id: &mut i32, binding: Option<Binding>) -> Result<Option<String>> {
        if current.as_ref().map(|value| &value.binding) == binding.as_ref() {
            return Ok(binding.map(|value| value.label));
        }
        let Some(binding) = binding else {
            if let Some(previous) = current.as_ref() {
                if unsafe { UnregisterHotKey(null_mut(), previous.id) } == 0 {
                    return Err(format!("无法停用截屏快捷键（系统代码 {}）。", unsafe { GetLastError() }));
                }
            }
            *current = None;
            return Ok(None);
        };
        let id = *next_id;
        *next_id = if id >= 0xbfff { 1 } else { id + 1 };
        let modifiers = 0x4000
            | (if binding.alt { 0x1 } else { 0 })
            | (if binding.control { 0x2 } else { 0 })
            | (if binding.shift { 0x4 } else { 0 })
            | (if binding.meta { 0x8 } else { 0 });
        let key = match binding.key {
            Key::Character(value) => u32::from(value),
            Key::Function(number) => 0x70 + u32::from(number - 1),
        };
        if unsafe { RegisterHotKey(null_mut(), id, modifiers, key) } == 0 {
            return Err(format!(
                "无法注册 {}，可能已被系统或其他应用占用；原快捷键保持不变（系统代码 {}）。",
                binding.label, unsafe { GetLastError() }
            ));
        }
        if let Some(previous) = current.as_ref() {
            if unsafe { UnregisterHotKey(null_mut(), previous.id) } == 0 {
                let error = unsafe { GetLastError() };
                unsafe { UnregisterHotKey(null_mut(), id); }
                return Err(format!("无法替换截屏快捷键，原快捷键保持不变（系统代码 {error}）。"));
            }
        }
        let label = binding.label.clone();
        *current = Some(Registration { binding, id });
        Ok(Some(label))
    }

    pub struct Manager {
        app: tauri::AppHandle,
        worker: Mutex<Option<Worker>>,
        closed: AtomicBool,
    }

    impl Manager {
        pub fn new(app: tauri::AppHandle) -> Self {
            Self { app, worker: Mutex::new(None), closed: AtomicBool::new(false) }
        }

        pub fn configure(&self, binding: Option<Binding>) -> Result<Option<String>> {
            let mut worker = self.worker.lock().map_err(|_| "截屏快捷键状态不可用。")?;
            if self.closed.load(Ordering::Acquire) {
                return Err("应用正在退出，无法设置截屏快捷键。".into());
            }
            if worker.is_none() {
                if binding.is_none() { return Ok(None); }
                *worker = Some(Worker::start(self.app.clone())?);
            }
            let (reply, result) = mpsc::channel();
            worker.as_ref().ok_or("截屏快捷键监听未启动。")?.send(Request::Configure(binding, reply))?;
            result.recv().map_err(|_| "截屏快捷键设置已中止。".to_owned())?
        }

        pub fn shutdown(&self) {
            self.closed.store(true, Ordering::Release);
            if let Ok(mut worker) = self.worker.lock() {
                worker.take();
            }
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod platform {
    use super::{Binding, Result};

    pub struct Manager;

    impl Manager {
        pub fn new(_app: tauri::AppHandle) -> Self { Self }

        pub fn configure(&self, binding: Option<Binding>) -> Result<Option<String>> {
            if binding.is_some() {
                Err("当前系统暂不支持全局截屏快捷键，请使用截屏按钮。".into())
            } else {
                Ok(None)
            }
        }

        pub fn shutdown(&self) {}
    }
}

#[cfg(test)]
mod tests {
    use super::{Binding, Key};

    #[test]
    fn portable_default_uses_the_platform_primary_modifier() {
        let mac = Binding::parse_for_platform("CommandOrControl+Shift+2", true).unwrap();
        assert_eq!(mac.label, "Cmd+Shift+2");
        assert!(mac.meta && !mac.control);
        let windows = Binding::parse_for_platform("CommandOrControl+Shift+2", false).unwrap();
        assert_eq!(windows.label, "Ctrl+Shift+2");
        assert!(windows.control && !windows.meta);
    }

    #[test]
    fn supported_keys_and_modifier_aliases_normalize() {
        let value = Binding::parse_for_platform(" option + control + shift + f20 ", true).unwrap();
        assert_eq!(value.label, "Ctrl+Alt+Shift+F20");
        assert_eq!(value.key, Key::Function(20));
        assert_eq!(Binding::parse_for_platform("super+a", true).unwrap().label, "Cmd+A");
    }

    #[test]
    fn unsafe_or_ambiguous_key_combinations_are_rejected() {
        for input in ["", "A", "Shift+A", "Ctrl", "Ctrl++A", "Ctrl+A+B", "Ctrl+Control+A", "Alt+F0", "Alt+F21", "Ctrl+F01", "Ctrl+Escape", "Ctrl+é"] {
            assert!(Binding::parse_for_platform(input, true).is_err(), "{input}");
        }
    }
}
