use crate::engine::Result;
use std::ffi::CStr;

fn appearance_name(theme: Option<&str>) -> Result<Option<&'static CStr>> {
    match theme {
        Some("dark") => Ok(Some(c"NSAppearanceNameDarkAqua")),
        Some("light") => Ok(Some(c"NSAppearanceNameAqua")),
        None => Ok(None),
        Some(_) => Err("窗口主题必须为 light、dark 或 null。".into()),
    }
}

#[cfg(feature = "desktop")]
pub async fn apply(window: tauri::WebviewWindow, theme: Option<String>) -> Result<()> {
    crate::capture_picker::require_main(&window)?;
    let appearance = appearance_name(theme.as_deref())?;
    #[cfg(target_os = "macos")]
    {
        let target = window.clone();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        window
            .run_on_main_thread(move || {
                let result = target
                    .ns_window()
                    .map_err(|error| format!("无法读取主窗口：{error}"))
                    .and_then(|native| unsafe { set_window_appearance(native, appearance) });
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

/// Must be called on the native main thread while the window is alive.
#[cfg(all(feature = "desktop", target_os = "macos"))]
unsafe fn set_window_appearance(window: *mut std::ffi::c_void, name: Option<&CStr>) -> Result<()> {
    use std::ffi::{c_char, c_void};
    #[link(name = "objc")]
    unsafe extern "C" {
        fn objc_getClass(name: *const c_char) -> *mut c_void;
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        #[link_name = "objc_msgSend"]
        fn send_message();
    }
    if window.is_null() {
        return Err("主窗口已经关闭，无法同步外观。".into());
    }
    let appearance = if let Some(name) = name {
        let string_class = objc_getClass(c"NSString".as_ptr());
        let appearance_class = objc_getClass(c"NSAppearance".as_ptr());
        if string_class.is_null() || appearance_class.is_null() {
            return Err("系统窗口外观组件不可用。".into());
        }
        let string_message: unsafe extern "C" fn(
            *mut c_void,
            *mut c_void,
            *const c_char,
        ) -> *mut c_void = std::mem::transmute(send_message as unsafe extern "C" fn());
        let string = string_message(
            string_class,
            sel_registerName(c"stringWithUTF8String:".as_ptr()),
            name.as_ptr(),
        );
        if string.is_null() {
            return Err("无法创建窗口主题名称。".into());
        }
        let object_message: unsafe extern "C" fn(
            *mut c_void,
            *mut c_void,
            *mut c_void,
        ) -> *mut c_void = std::mem::transmute(send_message as unsafe extern "C" fn());
        let appearance = object_message(
            appearance_class,
            sel_registerName(c"appearanceNamed:".as_ptr()),
            string,
        );
        if appearance.is_null() {
            return Err("系统不支持所选窗口外观。".into());
        }
        appearance
    } else {
        // Clear the window override as well as the application override in system mode.
        std::ptr::null_mut()
    };
    let set_appearance: unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void) =
        std::mem::transmute(send_message as unsafe extern "C" fn());
    // An application-wide appearance alone can leave native title chrome inheriting a
    // different appearance. Pin the main window itself so title text and background agree.
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
    fn explicit_themes_use_native_title_appearances_and_system_releases_the_override() {
        assert_eq!(
            appearance_name(Some("dark")).unwrap(),
            Some(c"NSAppearanceNameDarkAqua")
        );
        assert_eq!(
            appearance_name(Some("light")).unwrap(),
            Some(c"NSAppearanceNameAqua")
        );
        assert_eq!(appearance_name(None).unwrap(), None);
        for theme in ["", "system", "Dark", "aqua", "dark\0"] {
            assert!(appearance_name(Some(theme)).is_err());
        }
    }
}
