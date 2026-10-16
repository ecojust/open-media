fn main() {
    println!("cargo:rerun-if-changed=native/CaptureHelper.swift");
    println!("cargo:rerun-if-changed=native/CaptureHelper.plist");
    println!("cargo:rerun-if-env-changed=DOCS_RS");
    if std::env::var("CARGO_FEATURE_DESKTOP").is_ok()
        && std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos")
        && std::env::var_os("DOCS_RS").is_none()
    {
        build_capture_helper();
    }
    #[cfg(feature = "desktop")]
    tauri_build::build();
}

fn build_capture_helper() {
    use std::{path::PathBuf, process::Command};
    println!("cargo:rerun-if-changed=resources/capture/open-media-capture");
    let root = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let directory = root.join("resources/capture");
    std::fs::create_dir_all(&directory).expect("create capture resources");
    let output = directory.join("open-media-capture");
    let architecture = match std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("aarch64") => "arm64",
        Ok("x86_64") => "x86_64",
        _ => panic!("unsupported capture helper target"),
    };
    let status = Command::new("xcrun")
        .args(["swiftc", "-swift-version", "5", "-O", "-target"])
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
            "-sectcreate",
            "-Xlinker",
            "__TEXT",
            "-Xlinker",
            "__info_plist",
            "-Xlinker",
        ])
        .arg(root.join("native/CaptureHelper.plist"))
        .arg("-o")
        .arg(&output)
        .status()
        .expect("run native capture compiler");
    assert!(status.success(), "native capture helper compilation failed");
    let status = Command::new("codesign")
        .args([
            "--force",
            "--sign",
            "-",
            "--identifier",
            "com.ecojust.openmedia.capture",
        ])
        .arg(&output)
        .status()
        .expect("sign native capture helper");
    assert!(status.success(), "native capture helper signing failed");
    println!(
        "cargo:rustc-env=OPEN_MEDIA_CAPTURE_HELPER_PATH={}",
        output.display()
    );
}
