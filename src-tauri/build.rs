fn main() {
    println!("cargo:rerun-if-changed=native/CaptureHelper.swift");
    println!("cargo:rerun-if-env-changed=DOCS_RS");
    if std::env::var("CARGO_FEATURE_DESKTOP").is_ok()
        && std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos")
        && std::env::var_os("DOCS_RS").is_none()
    {
        build_capture_library();
    }
    #[cfg(feature = "desktop")]
    tauri_build::build();
}

fn build_capture_library() {
    use std::{path::PathBuf, process::Command};
    println!("cargo:rerun-if-changed=resources/capture/libopen_media_capture.dylib");
    let root = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let directory = root.join("resources/capture");
    std::fs::create_dir_all(&directory).expect("create capture resources");
    let output = directory.join("libopen_media_capture.dylib");
    let architecture = match std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("aarch64") => "arm64",
        Ok("x86_64") => "x86_64",
        _ => panic!("unsupported capture library target"),
    };
    let status = Command::new("xcrun")
        .args([
            "swiftc",
            "-swift-version",
            "5",
            "-O",
            "-emit-library",
            "-parse-as-library",
            "-module-name",
            "OpenMediaCapture",
            "-target",
        ])
        .arg(format!("{architecture}-apple-macos13.0"))
        .arg(root.join("native/CaptureHelper.swift"))
        .args([
            "-framework",
            "AppKit",
            "-framework",
            "AVFoundation",
            "-framework",
            "ScreenCaptureKit",
            "-framework",
            "CoreImage",
        ])
        .args([
            "-Xlinker",
            "-install_name",
            "-Xlinker",
            "@rpath/libopen_media_capture.dylib",
            "-Xlinker",
            "-rpath",
            "-Xlinker",
            "/usr/lib/swift",
        ])
        .arg("-o")
        .arg(&output)
        .status()
        .expect("run native capture compiler");
    assert!(status.success(), "native capture library compilation failed");
    let status = Command::new("codesign")
        .args([
            "--force",
            "--sign",
            "-",
            "--timestamp=none",
            "--identifier",
            "com.ecojust.openmedia.capture-library",
        ])
        .arg(&output)
        .status()
        .expect("sign native capture library");
    assert!(status.success(), "native capture library signing failed");
    println!(
        "cargo:rustc-env=OPEN_MEDIA_CAPTURE_LIBRARY_PATH={}",
        output.display()
    );
}
