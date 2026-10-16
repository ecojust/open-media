//! Run native recording under the application's own executable and code identity.
//! The recording implementation is linked into that executable, so starting a
//! capture never maps a separately signed application library at runtime.
//! A separate process still owns recording devices, the border and stdin shutdown.

use std::{path::Path, process::Command};

const CAPTURE_MODE: &str = "--open-media-capture";

fn command_for(executable: &Path) -> Command {
    // Media encoder flags must never be passed to the application executable.
    let mut command = Command::new(executable);
    command.arg(CAPTURE_MODE);
    command
}

pub fn command() -> crate::engine::Result<Command> {
    let executable =
        std::env::current_exe().map_err(|error| format!("无法定位当前应用程序：{error}"))?;
    Ok(command_for(&executable))
}

/// Call synchronously from main, before any desktop or worker runtime starts.
#[cfg(all(target_os = "macos", feature = "desktop"))]
pub fn run_if_requested() {
    if std::env::args_os().nth(1).as_deref() != Some(std::ffi::OsStr::new(CAPTURE_MODE)) {
        return;
    }
    extern "C" {
        fn open_media_capture_main() -> i32;
    }
    // The Swift entry point is part of this executable and checks that it runs
    // on the process main thread before initializing the native event loop.
    let code = unsafe { open_media_capture_main() };
    std::process::exit(code);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    #[test]
    fn capture_invokes_the_same_application_without_encoder_options() {
        let executable =
            Path::new("/Applications/测试目录/Open Media.app/Contents/MacOS/open-media");
        let mut command = command_for(executable);
        command.args(["sources", "--request-permission"]);
        assert_eq!(command.get_program(), executable.as_os_str());
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            [CAPTURE_MODE, "sources", "--request-permission"].map(OsStr::new)
        );
    }
}
