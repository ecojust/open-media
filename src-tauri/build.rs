use std::{path::PathBuf, process::Command};

fn main() {
    println!("cargo:rerun-if-changed=native/CaptureHelper.swift");
    for variable in ["DOCS_RS", "DEVELOPER_DIR", "SDKROOT", "TOOLCHAINS"] {
        println!("cargo:rerun-if-env-changed={variable}");
    }
    if std::env::var("CARGO_FEATURE_DESKTOP").is_ok()
        && std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos")
        && std::env::var_os("DOCS_RS").is_none()
    {
        build_capture_library();
    }
    #[cfg(feature = "desktop")]
    tauri_build::build();
}

fn xcrun_output(arguments: &[&str]) -> String {
    let output = Command::new("xcrun")
        .args(arguments)
        .output()
        .expect("run the selected native toolchain");
    assert!(
        output.status.success(),
        "native toolchain query failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout)
        .expect("native toolchain output must be UTF-8")
        .trim()
        .to_owned()
}

fn build_capture_library() {
    let root = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let directory = PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
    let output = directory.join("libopen_media_capture.a");
    let architecture = match std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("aarch64") => "arm64",
        Ok("x86_64") => "x86_64",
        _ => panic!("unsupported capture library target"),
    };
    let target = format!("{architecture}-apple-macos13.0");
    let sdk = xcrun_output(&["--sdk", "macosx", "--show-sdk-path"]);
    let target_info: serde_json::Value = serde_json::from_str(&xcrun_output(&[
        "--sdk",
        "macosx",
        "swiftc",
        "-print-target-info",
        "-target",
        &target,
        "-sdk",
        &sdk,
    ]))
    .expect("read native compiler target information");

    // Archive the app's recording implementation into the main executable.
    // System frameworks and the system Swift runtime keep their system identity;
    // there is no separately signed recording module to load at runtime.
    let status = Command::new("xcrun")
        .args([
            "--sdk",
            "macosx",
            "swiftc",
            "-swift-version",
            "5",
            "-O",
            "-emit-library",
            "-static",
            "-parse-as-library",
            "-module-name",
            "OpenMediaCapture",
            "-target",
            &target,
            "-sdk",
            &sdk,
        ])
        .arg(root.join("native/CaptureHelper.swift"))
        .arg("-o")
        .arg(&output)
        .status()
        .expect("run native capture compiler");
    assert!(
        status.success(),
        "native capture library compilation failed"
    );
    assert!(output.is_file(), "native capture archive was not produced");
    println!("cargo:rustc-link-search=native={}", directory.display());
    println!("cargo:rustc-link-lib=static=open_media_capture");

    // The final executable is linked by the Rust driver. Reproduce the Swift
    // driver's runtime and back-deployment inputs for the selected toolchain,
    // including SDK stubs and any compatibility archives this target requires.
    let paths = target_info["paths"]["runtimeLibraryPaths"]
        .as_array()
        .expect("native compiler must report runtime library paths");
    let mut runtime_paths: Vec<PathBuf> = paths
        .iter()
        .map(|path| {
            PathBuf::from(
                path.as_str()
                    .expect("runtime library path must be a string"),
            )
        })
        .collect();
    let resource_path = PathBuf::from(
        target_info["paths"]["runtimeResourcePath"]
            .as_str()
            .expect("native compiler must report its runtime resource path"),
    );
    for path in [
        resource_path.join("macosx"),
        PathBuf::from(&sdk).join("usr/lib/swift"),
    ] {
        if !runtime_paths.contains(&path) {
            runtime_paths.push(path);
        }
    }
    for path in &runtime_paths {
        println!("cargo:rustc-link-search=native={}", path.display());
    }
    if let Some(libraries) = target_info["target"]["compatibilityLibraries"].as_array() {
        for library in libraries {
            let filter = library["filter"].as_str().unwrap_or("all");
            if !matches!(filter, "all" | "executable") {
                continue;
            }
            let name = library["libraryName"]
                .as_str()
                .expect("compatibility library must have a name");
            assert!(
                !name.is_empty()
                    && name
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_'),
                "invalid compatibility library name"
            );
            // As in the native driver, absent back-deployment archives are
            // skipped: some toolchain versions provide those symbols elsewhere.
            if runtime_paths
                .iter()
                .any(|path| path.join(format!("lib{name}.a")).is_file())
            {
                if library["forceLoad"].as_bool().unwrap_or(true) {
                    println!("cargo:rustc-link-lib=static:+whole-archive={name}");
                } else {
                    println!("cargo:rustc-link-lib=static={name}");
                }
            }
        }
    }
    for framework in [
        "AppKit",
        "AVFoundation",
        "ScreenCaptureKit",
        "Foundation",
        "CoreGraphics",
        "CoreImage",
        "CoreMedia",
        "CoreVideo",
    ] {
        println!("cargo:rustc-link-lib=framework={framework}");
    }
    // Search the OS runtime only; never embed a build machine's toolchain path.
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
}
