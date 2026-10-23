use std::{
    cell::RefCell,
    process::{Child, ChildStdin},
    sync::mpsc::TryRecvError,
};

#[repr(C)]
struct MouseEvent {
    point: Point,
    data: u32,
    flags: u32,
    time: u32,
    extra: usize,
}
#[repr(C)]
struct CursorInfo {
    size: u32,
    flags: u32,
    cursor: Handle,
    position: Point,
}
#[repr(C)]
struct IconInfo {
    is_icon: i32,
    x_hotspot: u32,
    y_hotspot: u32,
    mask: Handle,
    color: Handle,
}
#[link(name = "user32")]
extern "system" {
    fn SetWindowsHookExW(
        kind: i32,
        callback: Option<unsafe extern "system" fn(i32, usize, isize) -> isize>,
        module: Handle,
        thread: u32,
    ) -> Handle;
    fn UnhookWindowsHookEx(hook: Handle) -> i32;
    fn CallNextHookEx(hook: Handle, code: i32, wparam: usize, lparam: isize) -> isize;
    fn GetAsyncKeyState(key: i32) -> i16;
    fn GetCursorInfo(info: *mut CursorInfo) -> i32;
    fn GetIconInfo(icon: Handle, info: *mut IconInfo) -> i32;
    fn DrawIconEx(
        dc: Handle,
        x: i32,
        y: i32,
        icon: Handle,
        width: i32,
        height: i32,
        step: u32,
        brush: Handle,
        flags: u32,
    ) -> i32;
}
#[link(name = "gdi32")]
extern "system" {
    fn StretchBlt(
        destination: Handle,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        source: Handle,
        sx: i32,
        sy: i32,
        sw: i32,
        sh: i32,
        operation: u32,
    ) -> i32;
    fn SetStretchBltMode(dc: Handle, mode: i32) -> i32;
    fn GetObjectW(object: Handle, size: i32, value: *mut c_void) -> i32;
    fn SetBrushOrgEx(dc: Handle, x: i32, y: i32, previous: *mut Point) -> i32;
    fn SaveDC(dc: Handle) -> i32;
    fn RestoreDC(dc: Handle, saved: i32) -> i32;
    fn IntersectClipRect(dc: Handle, left: i32, top: i32, right: i32, bottom: i32) -> i32;
}
#[repr(C)]
struct Bitmap {
    kind: i32,
    width: i32,
    height: i32,
    row_bytes: i32,
    planes: u16,
    bits_pixel: u16,
    bits: Handle,
}

thread_local! { static MOUSE_STATE: RefCell<Option<(Arc<Mutex<ZoomViewport>>, Arc<AtomicBool>)>> = const { RefCell::new(None) }; }
unsafe extern "system" fn mouse_proc(code: i32, wparam: usize, lparam: isize) -> isize {
    if code >= 0 && wparam == 0x020A && GetAsyncKeyState(0x11) < 0 && lparam != 0 {
        let event = &*(lparam as *const MouseEvent);
        // Do not capture wheel events injected by automation or another hook.
        if event.flags & 1 == 0 {
            let consumed = MOUSE_STATE.with(|state| {
                let state = state.borrow();
                let Some((viewport, enabled)) = state.as_ref() else {
                    return false;
                };
                if !enabled.load(Ordering::Acquire) {
                    return false;
                }
                viewport
                    .lock()
                    .map(|mut viewport| {
                        viewport.wheel(
                            f64::from(event.point.x),
                            f64::from(event.point.y),
                            f64::from((event.data >> 16) as i16) / 120.0,
                        )
                    })
                    .unwrap_or(false)
            });
            if consumed {
                return 1;
            }
        }
    }
    CallNextHookEx(null_mut(), code, wparam, lparam)
}
pub(super) struct WheelHook(Handle);
impl WheelHook {
    pub(super) fn install(
        viewport: Arc<Mutex<ZoomViewport>>,
        enabled: Arc<AtomicBool>,
    ) -> Result<Self> {
        MOUSE_STATE.with(|state| *state.borrow_mut() = Some((viewport, enabled)));
        let hook = unsafe { SetWindowsHookExW(14, Some(mouse_proc), GetModuleHandleW(null()), 0) };
        if hook.is_null() {
            MOUSE_STATE.with(|state| *state.borrow_mut() = None);
            return Err("无法启用录制范围缩放，请重新开始录制。".into());
        }
        Ok(Self(hook))
    }
}
impl Drop for WheelHook {
    fn drop(&mut self) {
        unsafe {
            UnhookWindowsHookEx(self.0);
        }
        MOUSE_STATE.with(|state| *state.borrow_mut() = None);
    }
}

struct FrameCanvas {
    bitmap: ScreenshotBitmap,
    pixels: *mut u8,
    width: i32,
    height: i32,
}
impl FrameCanvas {
    fn create(target: &VisualTarget, width: u32, height: u32) -> Result<Self> {
        let (width, height) = (
            i32::try_from(width).map_err(|_| "录制尺寸无效。")?,
            i32::try_from(height).map_err(|_| "录制尺寸无效。")?,
        );
        if width < 16 || height < 16 || i64::from(width) * i64::from(height) > 33_177_600 {
            return Err("录制尺寸无效。".into());
        }
        let window = if target.kind == "window" {
            parse_window_id(&target.id)?.0 as Hwnd
        } else {
            null_mut()
        };
        let mut bitmap = ScreenshotBitmap {
            window,
            source: unsafe { GetDC(window) },
            memory: null_mut(),
            bitmap: null_mut(),
            original: null_mut(),
        };
        if bitmap.source.is_null() {
            return Err("无法读取录制画面。".into());
        }
        bitmap.memory = unsafe { CreateCompatibleDC(bitmap.source) };
        if bitmap.memory.is_null() {
            return Err("无法创建录制画布。".into());
        }
        let header = BitmapInfoHeader {
            size: size_of::<BitmapInfoHeader>() as u32,
            width,
            height: -height,
            planes: 1,
            bit_count: 32,
            compression: 0,
            image_size: 0,
            x_pixels_per_meter: 0,
            y_pixels_per_meter: 0,
            colors_used: 0,
            colors_important: 0,
        };
        let mut pixels = null_mut();
        bitmap.bitmap =
            unsafe { CreateDIBSection(bitmap.source, &header, 0, &mut pixels, null_mut(), 0) };
        if bitmap.bitmap.is_null() || pixels.is_null() {
            return Err("无法分配录制像素。".into());
        }
        bitmap.original = unsafe { SelectObject(bitmap.memory, bitmap.bitmap) };
        if bitmap.original.is_null() || bitmap.original as isize == -1 {
            return Err("无法初始化录制像素。".into());
        }
        // HALFTONE requires resetting the brush origin after changing the mode.
        if unsafe { SetStretchBltMode(bitmap.memory, 4) } == 0
            || unsafe { SetBrushOrgEx(bitmap.memory, 0, 0, null_mut()) } == 0
        {
            return Err("无法初始化录制画面缩放。".into());
        }
        Ok(Self {
            bitmap,
            pixels: pixels.cast(),
            width,
            height,
        })
    }
    fn frame(&mut self, viewport: &ZoomViewport, target: &VisualTarget) -> Result<&[u8]> {
        let crop = viewport.local();
        let global = viewport.absolute();
        let factor = (f64::from(self.width) / f64::from(crop.width))
            .min(f64::from(self.height) / f64::from(crop.height));
        let width = (f64::from(crop.width) * factor).round() as i32;
        let height = (f64::from(crop.height) * factor).round() as i32;
        let x = (self.width - width) / 2;
        let y = (self.height - height) / 2;
        // Output dimensions never change, even while source bounds are zoomed.
        unsafe {
            std::ptr::write_bytes(
                self.pixels,
                0,
                self.width as usize * self.height as usize * 4,
            );
        }
        let (sx, sy) = if target.kind == "window" {
            (crop.x, crop.y)
        } else {
            (global.x, global.y)
        };
        let copied = unsafe {
            StretchBlt(
                self.bitmap.memory,
                x,
                y,
                width,
                height,
                self.bitmap.source,
                sx,
                sy,
                crop.width as i32,
                crop.height as i32,
                0x00CC0020 | 0x40000000,
            )
        };
        if copied == 0 {
            return Err("无法读取录制画面，已暂停录制。".into());
        }
        self.cursor(&global, x, y, width, height, factor);
        if unsafe { GdiFlush() } == 0 {
            return Err("录制画面刷新失败。".into());
        }
        Ok(unsafe {
            std::slice::from_raw_parts(self.pixels, self.width as usize * self.height as usize * 4)
        })
    }
    fn cursor(
        &self,
        bounds: &CaptureBounds,
        pad_x: i32,
        pad_y: i32,
        content_width: i32,
        content_height: i32,
        scale: f64,
    ) {
        let mut cursor: CursorInfo = unsafe { zeroed() };
        cursor.size = size_of::<CursorInfo>() as u32;
        if unsafe { GetCursorInfo(&mut cursor) } == 0
            || cursor.flags & 1 == 0
            || cursor.cursor.is_null()
        {
            return;
        }
        if cursor.position.x < bounds.x
            || cursor.position.y < bounds.y
            || i64::from(cursor.position.x) >= i64::from(bounds.x) + i64::from(bounds.width)
            || i64::from(cursor.position.y) >= i64::from(bounds.y) + i64::from(bounds.height)
        {
            return;
        }
        let mut icon: IconInfo = unsafe { zeroed() };
        if unsafe { GetIconInfo(cursor.cursor, &mut icon) } == 0 {
            return;
        }
        let mut bitmap: Bitmap = unsafe { zeroed() };
        let object = if !icon.color.is_null() {
            icon.color
        } else {
            icon.mask
        };
        if !object.is_null()
            && unsafe {
                GetObjectW(
                    object,
                    size_of::<Bitmap>() as i32,
                    (&mut bitmap as *mut Bitmap).cast(),
                )
            } != 0
        {
            let height = if icon.color.is_null() {
                bitmap.height / 2
            } else {
                bitmap.height
            };
            // Keep a scaled cursor inside the sampled picture, including when
            // its hotspot touches an edge next to letterbox padding.
            let saved = unsafe { SaveDC(self.bitmap.memory) };
            if saved != 0 {
                if bitmap.width > 0
                    && height > 0
                    && unsafe {
                        IntersectClipRect(
                            self.bitmap.memory,
                            pad_x,
                            pad_y,
                            pad_x + content_width,
                            pad_y + content_height,
                        )
                    } != 0
                {
                    unsafe {
                        DrawIconEx(
                            self.bitmap.memory,
                            pad_x
                                + ((f64::from(cursor.position.x)
                                    - f64::from(bounds.x)
                                    - f64::from(icon.x_hotspot))
                                    * scale)
                                    .round() as i32,
                            pad_y
                                + ((f64::from(cursor.position.y)
                                    - f64::from(bounds.y)
                                    - f64::from(icon.y_hotspot))
                                    * scale)
                                    .round() as i32,
                            cursor.cursor,
                            (f64::from(bitmap.width) * scale).round().max(1.0) as i32,
                            (f64::from(height) * scale).round().max(1.0) as i32,
                            0,
                            null_mut(),
                            3,
                        );
                    }
                }
                unsafe {
                    RestoreDC(self.bitmap.memory, saved);
                }
            }
        }
        unsafe {
            if !icon.mask.is_null() {
                DeleteObject(icon.mask);
            }
            if !icon.color.is_null() {
                DeleteObject(icon.color);
            }
        }
    }
}

pub(super) struct RecordingFrames {
    stop: Arc<AtomicBool>,
    finished: Receiver<()>,
    worker: Option<JoinHandle<()>>,
}
impl RecordingFrames {
    pub(super) fn start(
        mut input: ChildStdin,
        target: VisualTarget,
        viewport: Arc<Mutex<ZoomViewport>>,
        enabled: Arc<AtomicBool>,
        error: Arc<Mutex<Option<String>>>,
        width: u32,
        height: u32,
        fps: u32,
    ) -> Result<Self> {
        if !(1..=60).contains(&fps) {
            return Err("录制帧率应为 1 至 60。".into());
        }
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let (done, finished) = mpsc::channel();
        let worker = thread::Builder::new()
            .name("recording-frames".into())
            .spawn(move || {
                let _physical = PhysicalCoordinates::enter();
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let mut canvas = FrameCanvas::create(&target, width, height)?;
                    let interval = Duration::from_nanos(1_000_000_000 / u64::from(fps));
                    let mut deadline = Instant::now();
                    while !stopping.load(Ordering::Acquire) {
                        let view = viewport.lock().map_err(|_| "录制范围不可用。")?.clone();
                        let frame = canvas.frame(&view, &target)?;
                        input
                            .write_all(frame)
                            .map_err(|e| format!("录制画面写入失败：{e}"))?;
                        enabled.store(!stopping.load(Ordering::Acquire), Ordering::Release);
                        deadline += interval;
                        let now = Instant::now();
                        if deadline > now {
                            thread::sleep(deadline - now);
                        } else {
                            deadline = now;
                        }
                    }
                    Ok::<_, String>(())
                }))
                .unwrap_or_else(|_| Err("录制画面线程意外结束，已暂停录制。".into()));
                enabled.store(false, Ordering::Release);
                if let Err(reason) = result {
                    if !stopping.load(Ordering::Acquire) {
                        if let Ok(mut error) = error.lock() {
                            *error = Some(reason);
                        }
                    }
                }
                drop(input); // EOF, never mix interactive commands with BGRA pixels.
                let _ = done.send(());
            })
            .map_err(|e| format!("无法启动录制画面：{e}"))?;
        Ok(Self {
            stop,
            finished,
            worker: Some(worker),
        })
    }
    pub(super) fn finish(&mut self, child: &mut Child) {
        let Some(worker) = self.worker.take() else {
            return;
        };
        self.stop.store(true, Ordering::Release);
        // A stalled encoder can block a pipe write; terminate it before joining.
        if self.finished.recv_timeout(Duration::from_secs(2)).is_err() {
            let _ = child.kill();
            // Native capture itself can also stall. Never make UI teardown wait
            // indefinitely for a driver; dropping the handle detaches that worker.
            if self.finished.recv_timeout(Duration::from_secs(2)).is_err() && !worker.is_finished()
            {
                return;
            }
        }
        let _ = worker.join();
    }
}
impl Drop for RecordingFrames {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        // Normal teardown calls finish(child); do not block the UI on a pipe.
        if self.finished.try_recv() != Err(TryRecvError::Empty) {
            if let Some(worker) = self.worker.take() {
                let _ = worker.join();
            }
        }
    }
}

#[cfg(test)]
pub(super) fn fixture_frame(
    target: &VisualTarget,
    bounds: CaptureBounds,
    size: (u32, u32),
    steps: f64,
) -> Result<Vec<u8>> {
    let _physical = PhysicalCoordinates::enter();
    let pointer_x = f64::from(bounds.x) + f64::from(bounds.width) / 2.0;
    let pointer_y = f64::from(bounds.y) + f64::from(bounds.height) / 2.0;
    let mut viewport = ZoomViewport::new(bounds);
    viewport.wheel(pointer_x, pointer_y, steps);
    let mut canvas = FrameCanvas::create(target, size.0, size.1)?;
    let _ = unsafe { DwmFlush() };
    Ok(canvas.frame(&viewport, target)?.to_vec())
}
