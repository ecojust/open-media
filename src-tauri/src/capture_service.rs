//! Run native recording under the application's own executable and code identity.
//! The mode is dispatched before the desktop event loop starts. Its separate
//! process still owns recording devices, the border and shutdown through stdin.

use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
    process::Command,
};

const CAPTURE_MODE: &str = "--open-media-capture";
const LIBRARY_NAME: &str = "libopen_media_capture.dylib";

fn command_for(executable: &Path) -> Command {
    // Media encoder flags must never be passed to the application executable.
    let mut command = Command::new(executable);
    command.arg(CAPTURE_MODE);
    command
}

pub fn command() -> crate::engine::Result<Command> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("无法定位当前应用程序：{error}"))?;
    Ok(command_for(&executable))
}

fn library_for(executable: &Path, development: Option<&Path>) -> crate::engine::Result<PathBuf> {
    let directory = executable.parent().ok_or("应用程序路径无效。")?;
    let contents = directory.parent();
    if directory.file_name() == Some(OsStr::new("MacOS"))
        && contents.and_then(Path::file_name) == Some(OsStr::new("Contents"))
    {
        let library = contents.unwrap().join("Frameworks").join(LIBRARY_NAME);
        return library
            .is_file()
            .then_some(library)
            .ok_or_else(|| "应用包内的录屏组件缺失，请重新安装完整应用。".into());
    }
    development
        .filter(|path| path.is_absolute() && path.is_file())
        .map(Path::to_path_buf)
        .ok_or_else(|| "请从完整的 Open Media 应用包启动录制。".into())
}

#[cfg(target_os = "macos")]
fn native_main() -> crate::engine::Result<i32> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};

    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    // A packaged app always uses its own signed Frameworks directory. Only an
    // unbundled debug build may use the absolute path embedded by build.rs.
    #[cfg(debug_assertions)]
    let development = option_env!("OPEN_MEDIA_CAPTURE_LIBRARY_PATH").map(Path::new);
    #[cfg(not(debug_assertions))]
    let development = None;
    let library = library_for(&executable, development)?;
    let path = CString::new(library.as_os_str().as_bytes())
        .map_err(|_| "录屏组件路径包含无效字符。")?;

    #[link(name = "System")]
    extern "C" {
        fn dlopen(path: *const std::ffi::c_char, flags: i32) -> *mut std::ffi::c_void;
        fn dlsym(handle: *mut std::ffi::c_void, name: *const std::ffi::c_char)
            -> *mut std::ffi::c_void;
        fn dlerror() -> *const std::ffi::c_char;
    }
    fn last_error() -> String {
        unsafe {
            let error = dlerror();
            if error.is_null() {
                "系统未返回详细原因。".into()
            } else {
                std::ffi::CStr::from_ptr(error).to_string_lossy().into_owned()
            }
        }
    }
    const RTLD_NOW: i32 = 0x2;
    const RTLD_LOCAL: i32 = 0x4;
    unsafe {
        let handle = dlopen(path.as_ptr(), RTLD_NOW | RTLD_LOCAL);
        if handle.is_null() {
            return Err(format!("无法加载应用内的录屏组件：{}", last_error()));
        }
        let symbol = dlsym(handle, c"open_media_capture_main".as_ptr());
        if symbol.is_null() {
            return Err(format!("录屏组件入口不可用：{}", last_error()));
        }
        // Keep the library loaded until this process exits: its delegates and
        // signal handlers remain live while the native event loop is running.
        let entry: unsafe extern "C" fn() -> i32 = std::mem::transmute(symbol);
        Ok(entry())
    }
}

/// Call synchronously from main, before any desktop or worker runtime starts.
#[cfg(target_os = "macos")]
pub fn run_if_requested() {
    if std::env::args_os().nth(1).as_deref() != Some(OsStr::new(CAPTURE_MODE)) {
        return;
    }
    let code = match native_main() {
        Ok(code) => code,
        Err(error) => {
            eprintln!("{error}");
            1
        }
    };
    std::process::exit(code);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_invokes_the_same_application_without_encoder_options() {
        let executable = Path::new("/Applications/测试目录/Open Media.app/Contents/MacOS/open-media");
        let mut command = command_for(executable);
        command.args(["sources", "--request-permission"]);
        assert_eq!(command.get_program(), executable.as_os_str());
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            [CAPTURE_MODE, "sources", "--request-permission"].map(OsStr::new)
        );
    }

    #[test]
    fn packaged_recording_uses_frameworks_and_never_a_development_fallback() {
        let root = tempfile::tempdir().unwrap();
        let contents = root.path().join("中文应用/Open Media.app/Contents");
        let executable = contents.join("MacOS/open-media");
        let development = root.path().join(LIBRARY_NAME);
        std::fs::write(&development, "development").unwrap();
        assert!(library_for(&executable, Some(&development)).is_err());
        let packaged = contents.join("Frameworks").join(LIBRARY_NAME);
        std::fs::create_dir_all(packaged.parent().unwrap()).unwrap();
        std::fs::write(&packaged, "packaged").unwrap();
        assert_eq!(library_for(&executable, Some(&development)).unwrap(), packaged);
    }

    #[test]
    fn unbundled_recording_requires_an_explicit_existing_absolute_development_path() {
        let root = tempfile::tempdir().unwrap();
        let executable = root.path().join("target/debug/open-media");
        let development = root.path().join(LIBRARY_NAME);
        assert!(library_for(&executable, None).is_err());
        assert!(library_for(&executable, Some(&development)).is_err());
        std::fs::write(&development, "development").unwrap();
        assert_eq!(library_for(&executable, Some(&development)).unwrap(), development);
        assert!(library_for(&executable, Some(Path::new(LIBRARY_NAME))).is_err());
    }
}
