#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    #[cfg(target_os = "macos")]
    open_media_lib::capture_service::run_if_requested();
    open_media_lib::run();
}
