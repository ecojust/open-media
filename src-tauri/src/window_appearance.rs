use crate::engine::Result;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Appearance {
    Dark,
    Light,
}

fn appearance(theme: Option<&str>) -> Result<Option<Appearance>> {
    match theme {
        Some("dark") => Ok(Some(Appearance::Dark)),
        Some("light") => Ok(Some(Appearance::Light)),
        None => Ok(None),
        Some(_) => Err("窗口主题必须为 light、dark 或 null。".into()),
    }
}

#[cfg(feature = "desktop")]
pub async fn apply(window: tauri::WebviewWindow, theme: Option<String>) -> Result<()> {
    crate::capture_picker::require_main(&window)?;
    let appearance = appearance(theme.as_deref())?;
    #[cfg(target_os = "macos")]
    {
        let target = window.clone();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        window
            .run_on_main_thread(move || {
                let result = target
                    .ns_window()
                    .map_err(|error| format!("无法读取主窗口：{error}"))
                    .and_then(|native| unsafe {
                        native::set_window_appearance(native, appearance)
                    });
                let _ = sender.send(result);
            })
            .map_err(|error| format!("无法同步主窗口外观：{error}"))?;
        receiver
            .await
            .map_err(|_| "主窗口外观同步被中断。".to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Other desktop platforms already apply the native window theme through the window API.
        let _ = appearance;
        Ok(())
    }
}

#[cfg(all(feature = "desktop", target_os = "macos"))]
mod native {
    use super::{Appearance, Result};
    use std::ffi::{c_char, c_void};

    type Object = *mut c_void;

    // These are exported NSString objects, not their C symbol names. Constructing
    // a string such as "NSAppearanceNameDarkAqua" does not resolve an appearance.
    #[link(name = "AppKit", kind = "framework")]
    unsafe extern "C" {
        static NSAppearanceNameAqua: Object;
        static NSAppearanceNameDarkAqua: Object;
    }

    #[link(name = "objc")]
    unsafe extern "C" {
        fn objc_getClass(name: *const c_char) -> Object;
        fn sel_registerName(name: *const c_char) -> Object;
        #[link_name = "objc_msgSend"]
        fn send_message();
    }

    unsafe fn appearance_name(appearance: Appearance) -> Object {
        match appearance {
            Appearance::Dark => NSAppearanceNameDarkAqua,
            Appearance::Light => NSAppearanceNameAqua,
        }
    }

    unsafe fn resolve(appearance: Option<Appearance>) -> Result<Object> {
        let Some(appearance) = appearance else {
            // Clearing the window override restores the inherited system appearance.
            return Ok(std::ptr::null_mut());
        };
        let name = appearance_name(appearance);
        let appearance_class = objc_getClass(c"NSAppearance".as_ptr());
        if name.is_null() || appearance_class.is_null() {
            return Err("系统窗口外观组件不可用。".into());
        }
        let object_message: unsafe extern "C" fn(Object, Object, Object) -> Object =
            std::mem::transmute(send_message as unsafe extern "C" fn());
        let resolved = object_message(
            appearance_class,
            sel_registerName(c"appearanceNamed:".as_ptr()),
            name,
        );
        if resolved.is_null() {
            return Err("系统不支持所选窗口外观。".into());
        }
        Ok(resolved)
    }

    /// Must be called on the native main thread while the window is alive.
    pub(super) unsafe fn set_window_appearance(
        window: Object,
        appearance: Option<Appearance>,
    ) -> Result<()> {
        if window.is_null() {
            return Err("主窗口已经关闭，无法同步外观。".into());
        }
        let appearance = resolve(appearance)?;
        let set_appearance: unsafe extern "C" fn(Object, Object, Object) =
            std::mem::transmute(send_message as unsafe extern "C" fn());
        // Pin the window itself so the native title and its background share an appearance.
        set_appearance(
            window,
            sel_registerName(c"setAppearance:".as_ptr()),
            appearance,
        );
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn native_appearances_resolve_and_dark_text_is_light() {
            // Exercise AppKit itself without creating windows on a Rust test thread.
            // NSAppearance's current appearance is local to the calling thread.
            unsafe {
                unsafe extern "C" {
                    fn objc_autoreleasePoolPush() -> Object;
                    fn objc_autoreleasePoolPop(pool: Object);
                }
                let get: unsafe extern "C" fn(Object, Object) -> Object =
                    std::mem::transmute(send_message as unsafe extern "C" fn());
                let object: unsafe extern "C" fn(Object, Object, Object) -> Object =
                    std::mem::transmute(send_message as unsafe extern "C" fn());
                let set: unsafe extern "C" fn(Object, Object, Object) =
                    std::mem::transmute(send_message as unsafe extern "C" fn());
                let equal: unsafe extern "C" fn(Object, Object, Object) -> bool =
                    std::mem::transmute(send_message as unsafe extern "C" fn());
                let components: unsafe extern "C" fn(
                    Object,
                    Object,
                    *mut f64,
                    *mut f64,
                    *mut f64,
                    *mut f64,
                ) = std::mem::transmute(send_message as unsafe extern "C" fn());

                struct Restore {
                    pool: Object,
                    appearance_class: Object,
                    previous: Object,
                }
                impl Drop for Restore {
                    fn drop(&mut self) {
                        unsafe {
                            let set: unsafe extern "C" fn(Object, Object, Object) =
                                std::mem::transmute(send_message as unsafe extern "C" fn());
                            set(
                                self.appearance_class,
                                sel_registerName(c"setCurrentAppearance:".as_ptr()),
                                self.previous,
                            );
                            let release: unsafe extern "C" fn(Object, Object) =
                                std::mem::transmute(send_message as unsafe extern "C" fn());
                            release(self.previous, sel_registerName(c"release".as_ptr()));
                            objc_autoreleasePoolPop(self.pool);
                        }
                    }
                }

                let pool = objc_autoreleasePoolPush();
                let appearance_class = objc_getClass(c"NSAppearance".as_ptr());
                let _restore = Restore {
                    pool,
                    appearance_class,
                    previous: get(
                        get(
                            appearance_class,
                            sel_registerName(c"currentAppearance".as_ptr()),
                        ),
                        sel_registerName(c"retain".as_ptr()),
                    ),
                };
                let space = get(
                    objc_getClass(c"NSColorSpace".as_ptr()),
                    sel_registerName(c"genericRGBColorSpace".as_ptr()),
                );
                assert!(!space.is_null());
                let mut brightness = Vec::new();
                for theme in [Appearance::Light, Appearance::Dark] {
                    let appearance = resolve(Some(theme)).expect("native appearance must resolve");
                    assert!(equal(
                        get(appearance, sel_registerName(c"name".as_ptr())),
                        sel_registerName(c"isEqualToString:".as_ptr()),
                        appearance_name(theme),
                    ));
                    set(
                        appearance_class,
                        sel_registerName(c"setCurrentAppearance:".as_ptr()),
                        appearance,
                    );
                    let label = get(
                        objc_getClass(c"NSColor".as_ptr()),
                        sel_registerName(c"labelColor".as_ptr()),
                    );
                    let rgb = object(
                        label,
                        sel_registerName(c"colorUsingColorSpace:".as_ptr()),
                        space,
                    );
                    assert!(!rgb.is_null());
                    let (mut red, mut green, mut blue, mut alpha) = (0., 0., 0., 0.);
                    components(
                        rgb,
                        sel_registerName(c"getRed:green:blue:alpha:".as_ptr()),
                        &mut red,
                        &mut green,
                        &mut blue,
                        &mut alpha,
                    );
                    assert!(alpha > 0.5);
                    brightness.push((red + green + blue) / 3.);
                }
                assert!(
                    brightness[0] < 0.4,
                    "light appearance needs dark text: {brightness:?}"
                );
                assert!(
                    brightness[1] > 0.7,
                    "dark appearance needs light text: {brightness:?}"
                );
                assert!(
                    resolve(None).unwrap().is_null(),
                    "system mode must clear the override"
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_themes_use_native_title_appearances_and_system_releases_the_override() {
        assert_eq!(appearance(Some("dark")).unwrap(), Some(Appearance::Dark));
        assert_eq!(appearance(Some("light")).unwrap(), Some(Appearance::Light));
        assert_eq!(appearance(None).unwrap(), None);
        for theme in ["", "system", "Dark", "aqua", "dark\0"] {
            assert!(appearance(Some(theme)).is_err());
        }
    }
}
