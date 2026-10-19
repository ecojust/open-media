use std::{path::PathBuf, process::Command};

fn main() {
    println!("cargo:rerun-if-changed=native/CaptureHelper.swift");
    println!("cargo:rerun-if-changed=native/video-generation");
    println!("cargo:rerun-if-changed=resources/video-generation-models.json");
    for variable in ["DOCS_RS", "DEVELOPER_DIR", "SDKROOT", "TOOLCHAINS"] {
        println!("cargo:rerun-if-env-changed={variable}");
    }
    if std::env::var("CARGO_FEATURE_DESKTOP").is_ok()
        && std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos")
        && std::env::var_os("DOCS_RS").is_none()
    {
        build_capture_library();
    }
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos")
        && std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("aarch64")
        && std::env::var_os("DOCS_RS").is_none()
    {
        build_video_generation_runner();
    }
    #[cfg(feature = "desktop")]
    tauri_build::build();
}

fn build_video_generation_runner() {
    let root = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let output_dir = PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
    let source = root.join("native/video-generation");
    let upstream = source.join("upstream");
    let sdk = xcrun_output(&["--sdk", "macosx", "--show-sdk-path"]);
    let sdk_version = xcrun_output(&["--sdk", "macosx", "--show-sdk-version"]);
    let sdk_major = sdk_version
        .split('.')
        .next()
        .unwrap_or("0")
        .parse::<u32>()
        .unwrap_or(0);
    assert!(sdk_major >= 26,
        "video generation requires the macOS 26 SDK or newer at build time; select Xcode 26 with DEVELOPER_DIR (selected SDK: {sdk_version})");
    let manifest: serde_json::Value = serde_json::from_slice(
        &std::fs::read(root.join("resources/video-generation-models.json")).unwrap(),
    )
    .expect("read the pinned video engine revision");
    let revision = manifest["engine"]["version"].as_str().unwrap();
    assert!(revision.len() == 40 && revision.bytes().all(|byte| byte.is_ascii_hexdigit()));
    let source_names = [
        "h3.c",
        "h3_host.c",
        "h3_safetensors.c",
        "h3_weights.c",
        "h3_text_encoder.c",
        "h3_dit_schedule.c",
        "h3_dit.c",
        "h3_video_vae.c",
        "h3_video_encoder.c",
        "h3_audio_vae.c",
        "h3_ffmpeg.c",
        "h3_terminal.c",
        "h3_vision_encoder.c",
        "h3_multimodal.c",
        "h3_metal.m",
        "h3_gpu.m",
        "h3_tokenizer.m",
    ];
    let mut sources: Vec<PathBuf> = source_names
        .iter()
        .map(|name| upstream.join(name))
        .collect();
    sources.push(source.join("runner.m"));
    let mut objects = Vec::new();
    // Isolated object files avoid touching the vendored source tree. This helper
    // is embedded in the application; users never need an installed compiler.
    for file in sources {
        let object = output_dir.join(format!(
            "video_{}.o",
            file.file_stem().unwrap().to_string_lossy()
        ));
        let mut command = Command::new("xcrun");
        command.args([
            "--sdk",
            "macosx",
            "clang",
            "-std=c11",
            "-O3",
            "-Wall",
            "-Wextra",
            "-D_DARWIN_C_SOURCE",
            "-target",
            "arm64-apple-macos15.0",
            "-isysroot",
            &sdk,
        ]);
        if file.extension().is_some_and(|extension| extension == "m") {
            command.arg("-fobjc-arc");
        }
        command
            .arg(format!("-DOPEN_MEDIA_VIDEO_ENGINE_REVISION=\"{revision}\""))
            .arg("-I")
            .arg(&upstream)
            .arg("-c")
            .arg(&file)
            .arg("-o")
            .arg(&object);
        assert!(
            command
                .status()
                .expect("run native video generation compiler")
                .success(),
            "video generation compilation failed for {}",
            file.display()
        );
        objects.push(object);
    }
    let executable = output_dir.join("open-media-video-generation");
    let mut linker = Command::new("xcrun");
    linker.args([
        "--sdk",
        "macosx",
        "clang",
        "-target",
        "arm64-apple-macos15.0",
        "-isysroot",
        &sdk,
    ]);
    linker.args(objects).arg("-o").arg(&executable);
    for framework in [
        "Foundation",
        "Metal",
        "MetalPerformanceShaders",
        "MetalPerformanceShadersGraph",
        "Accelerate",
    ] {
        linker.arg("-framework").arg(framework);
    }
    linker.args(["-licucore", "-lm"]);
    assert!(
        linker
            .status()
            .expect("link video generation runner")
            .success(),
        "video generation runner linking failed"
    );
    assert!(
        Command::new("/usr/bin/codesign")
            .args(["--force", "--sign", "-", "--timestamp=none"])
            .arg(&executable)
            .status()
            .expect("sign isolated video generation runner")
            .success(),
        "video generation runner ad-hoc signing failed"
    );
    std::fs::copy(
        upstream.join("h3_shaders.metal"),
        output_dir.join("h3_shaders.metal"),
    )
    .expect("embed video generation shaders");
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
