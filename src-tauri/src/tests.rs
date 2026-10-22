use crate::{capture::parse_devices, engine::*};
use serde_json::{json, Value};
use std::{
    fs,
    path::Path,
    thread,
    time::{Duration, Instant},
};
#[path = "media_performance_tests.rs"]
mod media_performance_tests;
#[path = "motion_style_export_tests.rs"]
mod motion_style_export_tests;
#[path = "track_layer_tests.rs"]
mod track_layer_tests;
fn runtime() -> Runtime {
    Runtime::discover(None, None).expect("Media runtime required for integration checks")
}
fn sample(root: &Path, runtime: &Runtime) -> Asset {
    let source = root.join("source.mp4");
    let out = process(&runtime.encoder)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=red:s=160x120:r=20:d=1",
            "-f",
            "lavfi",
            "-i",
            "color=c=blue:s=160x120:r=20:d=1",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=44100:duration=2",
            "-filter_complex",
            "[0:v][1:v]concat=n=2:v=1:a=0[v]",
            "-map",
            "[v]",
            "-map",
            "2:a",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-t",
            "2",
        ])
        .arg(&source)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    MediaStore::new(root)
        .unwrap()
        .import(runtime, &source, None)
        .unwrap()
}
fn wait(jobs: &JobManager, id: &str) -> MediaJob {
    let started = Instant::now();
    let deadline = started + Duration::from_secs(60);
    let diagnostic = std::env::var_os("OPEN_MEDIA_TEST_PROGRESS").is_some();
    let mut next_report = started + Duration::from_secs(5);
    loop {
        let item = jobs.list().into_iter().find(|j| j.id == id).unwrap();
        if item.state != "running" {
            return item;
        }
        if diagnostic && Instant::now() >= next_report {
            eprintln!("NATIVE_JOB_PROGRESS {}", serde_json::to_string(&item).unwrap());
            next_report = Instant::now() + Duration::from_secs(5);
        }
        if Instant::now() >= deadline {
            // Keep the existing deadline, but report the actual stalled phase
            // and release the encoder instead of leaving it running after panic.
            let _ = jobs.cancel(id);
            let cleanup = Instant::now() + Duration::from_secs(5);
            while Instant::now() < cleanup && jobs.list().iter().any(|job| job.id == id && job.state == "running") {
                thread::sleep(Duration::from_millis(30));
            }
            panic!("job timeout after {:.2}s: {}", started.elapsed().as_secs_f64(), serde_json::to_string(&item).unwrap());
        }
        thread::sleep(Duration::from_millis(30));
    }
}
fn run(root: &Path, runtime: &Runtime, spec: Value, name: &str) -> (MediaJob, Value) {
    let store = MediaStore::new(root).unwrap();
    let jobs = JobManager::default();
    let target = root.join(name);
    let job = jobs
        .begin(
            runtime,
            build_plan(&store, runtime, &spec).unwrap(),
            target.clone(),
        )
        .unwrap();
    let job = wait(&jobs, &job.id);
    assert_eq!(job.state, "completed", "{:?}", job.error);
    let out = process(&runtime.probe)
        .args([
            "-v",
            "error",
            "-show_format",
            "-show_streams",
            "-of",
            "json",
        ])
        .arg(target)
        .output()
        .unwrap();
    assert!(out.status.success());
    (job, serde_json::from_slice(&out.stdout).unwrap())
}
#[test]
fn imported_asset_is_persistent_and_scoped() {
    let temp = tempfile::tempdir().unwrap();
    let rt = runtime();
    let asset = sample(temp.path(), &rt);
    fs::remove_file(temp.path().join("source.mp4")).unwrap();
    assert_eq!(asset.kind, "video");
    assert_eq!(asset.width, 160);
    let restored = MediaStore::new(temp.path()).unwrap();
    assert!(restored
        .authorized_path(&serde_json::to_value(asset).unwrap())
        .is_ok());
    assert!(restored
        .authorized_path(&json!({"nativePath":"/etc/passwd"}))
        .is_err());
}
#[test]
fn convert_trim_has_expected_duration_and_audio() {
    let temp = tempfile::tempdir().unwrap();
    let rt = runtime();
    let asset = sample(temp.path(), &rt);
    let (job, probe) = run(
        temp.path(),
        &rt,
        json!({"kind":"convert","asset":asset,"format":"mp4","width":80,"height":60,"fps":10,"trimStart":0.25,"trimEnd":1.25}),
        "trim.mp4",
    );
    assert_eq!(job.progress, 1.0);
    assert_eq!(probe["streams"][0]["width"], 80);
    assert_eq!(probe["streams"][0]["height"], 60);
    let duration = probe["format"]["duration"]
        .as_str()
        .unwrap()
        .parse::<f64>()
        .unwrap();
    assert!((duration - 1.0).abs() < 0.15);
    assert!(probe["streams"]
        .as_array()
        .unwrap()
        .iter()
        .any(|s| s["codec_type"] == "audio"));
}
#[test]
fn gif_segments_preserve_requested_order() {
    let temp = tempfile::tempdir().unwrap();
    let rt = runtime();
    let asset = sample(temp.path(), &rt);
    let (_, probe) = run(
        temp.path(),
        &rt,
        json!({"kind":"gif","asset":asset,"segments":[{"start":1.1,"end":1.7},{"start":0.1,"end":0.7}],"width":80,"fps":10,"loop":false}),
        "joined.gif",
    );
    assert_eq!(probe["streams"][0]["codec_name"], "gif");
    let pixels = process(&rt.encoder)
        .args(["-v", "error", "-i"])
        .arg(temp.path().join("joined.gif"))
        .args([
            "-vf",
            "scale=1:1",
            "-frames:v",
            "1",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-",
        ])
        .output()
        .unwrap();
    assert!(pixels.status.success());
    assert!(
        pixels.stdout[2] > 200 && pixels.stdout[0] < 50,
        "first segment must be blue"
    );
}
#[test]
fn audio_extraction_and_image_conversion() {
    let temp = tempfile::tempdir().unwrap();
    let rt = runtime();
    let asset = sample(temp.path(), &rt);
    let (_, probe) = run(
        temp.path(),
        &rt,
        json!({"kind":"convert","asset":asset,"format":"wav","sampleRate":16000}),
        "sound.wav",
    );
    assert_eq!(probe["streams"][0]["codec_type"], "audio");
    assert_eq!(probe["streams"][0]["sample_rate"], "16000");
    let (_, probe) = run(
        temp.path(),
        &rt,
        json!({"kind":"convert","asset":asset,"format":"webp","width":64}),
        "image.webp",
    );
    assert_eq!(probe["streams"][0]["width"], 64);
}
fn clip(asset: &Asset) -> Value {
    json!({"id":"clip","assetId":asset.id,"name":"sample","start":0.2,"trimIn":0.0,"trimOut":2.0,"speed":2.0,"volume":0.8,"opacity":0.8,"x":20.0,"y":10.0,"width":100.0,"height":80.0,"rotation":15.0,"fit":"contain","fadeIn":0.1,"fadeOut":0.1})
}

fn decoded_audio(runtime: &Runtime, path: &Path) -> Vec<f32> {
    let output = process(&runtime.encoder)
        .args(["-v", "error", "-i"])
        .arg(path)
        .args(["-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    output
        .stdout
        .chunks_exact(4)
        .map(|bytes| f32::from_le_bytes(bytes.try_into().unwrap()))
        .collect()
}

fn audio_window(samples: &[f32], start: f64, duration: f64) -> &[f32] {
    &samples[(start * 16000.0).round() as usize..((start + duration) * 16000.0).round() as usize]
}

fn audio_rms(samples: &[f32]) -> f64 {
    (samples
        .iter()
        .map(|value| f64::from(*value).powi(2))
        .sum::<f64>()
        / samples.len() as f64)
        .sqrt()
}

#[test]
fn timeline_audio_extension_repeats_source_with_offset_speed_and_clip_fades() {
    let temp = tempfile::tempdir().unwrap();
    let rt = runtime();
    let source = temp.path().join("alternating.wav");
    let output = process(&rt.encoder)
        .args([
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000:duration=0.5",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=880:sample_rate=48000:duration=0.5",
            "-filter_complex",
            "[0:a][1:a]concat=n=2:v=0:a=1[a]",
            "-map",
            "[a]",
            "-c:a",
            "pcm_s16le",
        ])
        .arg(&source)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let asset = MediaStore::new(temp.path())
        .unwrap()
        .import(&rt, &source, None)
        .unwrap();
    assert!((asset.duration - 1.0).abs() < 0.001);
    let spec = json!({"kind":"timeline","project":{"width":160,"height":120,"assets":[asset.clone()],"tracks":[{"kind":"audio","clips":[{"id":"loop","assetId":asset.id,"start":0.4,"trimIn":2.2,"trimOut":8.2,"speed":2,"volume":1,"fadeIn":0.2,"fadeOut":0.2}]}]},"config":{"format":"mp4","width":160,"height":120,"fps":20}});
    let (_, probe) = run(temp.path(), &rt, spec, "looped.mp4");
    let duration = probe["format"]["duration"]
        .as_str()
        .unwrap()
        .parse::<f64>()
        .unwrap();
    assert!(
        (duration - 3.4).abs() < 0.1,
        "extended duration: {duration}"
    );
    let samples = decoded_audio(&rt, &temp.path().join("looped.mp4"));
    assert!(
        audio_rms(audio_window(&samples, 0.1, 0.1)) < 0.001,
        "track start must remain silent"
    );
    for (time, frequency) in [
        (0.45, 440.0),
        (0.7, 880.0),
        (1.45, 440.0),
        (1.7, 880.0),
        (2.95, 440.0),
        (3.2, 880.0),
    ] {
        let window = audio_window(&samples, time, 0.05);
        assert!(
            audio_rms(window) > 0.01,
            "loop unexpectedly silent at {time}"
        );
        let crossings = window
            .windows(2)
            .filter(|pair| pair[0] <= 0.0 && pair[1] > 0.0)
            .count();
        let actual = crossings as f64 / 0.05;
        assert!(
            (actual - frequency).abs() < 100.0,
            "loop phase changed at {time}: {actual} instead of {frequency}"
        );
    }
    let middle = audio_rms(audio_window(&samples, 1.1, 0.05));
    assert!(
        audio_rms(audio_window(&samples, 0.41, 0.02)) < middle * 0.4,
        "fade-in belongs to the whole extended clip"
    );
    assert!(
        audio_rms(audio_window(&samples, 3.36, 0.02)) < middle * 0.4,
        "fade-out belongs to the whole extended clip"
    );
}

#[test]
fn timeline_loops_video_sound_only_when_used_on_an_audio_track() {
    let temp = tempfile::tempdir().unwrap();
    let rt = runtime();
    let asset = sample(temp.path(), &rt);
    let mut spec = json!({"kind":"timeline","project":{"width":160,"height":120,"assets":[asset.clone()],"tracks":[{"kind":"audio","clips":[{"id":"sound","assetId":asset.id,"start":0,"trimIn":2.5,"trimOut":5.5,"speed":2,"volume":1}]}]},"config":{"format":"mp4","width":160,"height":120,"fps":20}});
    let (_, probe) = run(temp.path(), &rt, spec.clone(), "video-sound-loop.mp4");
    let duration = probe["format"]["duration"]
        .as_str()
        .unwrap()
        .parse::<f64>()
        .unwrap();
    assert!((duration - 1.5).abs() < 0.1);
    let samples = decoded_audio(&rt, &temp.path().join("video-sound-loop.mp4"));
    assert!(
        audio_rms(audio_window(&samples, 1.2, 0.1)) > 0.01,
        "extracted sound must repeat past the source end"
    );
    spec["project"]["tracks"][0]["kind"] = json!("video");
    let error = build_plan(&MediaStore::new(temp.path()).unwrap(), &rt, &spec)
        .err()
        .expect("visual video clips cannot exceed source duration");
    assert!(error.contains("原始时长"), "{error}");
}

#[test]
fn clip_filter_graph_preserves_each_alpha_byte_and_luma_grayscale() {
    let temp = tempfile::tempdir().unwrap();
    let rt = runtime();
    let pixels: Vec<u8> = [
        [255, 0, 0, 255],
        [64, 160, 240, 128],
        [0, 255, 0, 0],
        [0, 0, 255, 64],
        [0, 0, 255, 255],
        [160, 40, 10, 192],
        [255, 0, 0, 32],
        [0, 255, 0, 1],
    ]
    .into_iter()
    .flatten()
    .collect();
    let source = temp.path().join("rgba.raw");
    fs::write(&source, &pixels).unwrap();
    let filter = crate::clip_filters::filter_chain(
        &json!({"filters":{"enabled":true,"intensity":1,"brightness":0,"contrast":1,"saturation":0,"temperature":0,"tint":0,"sepia":0}}),
        true,
    )
    .unwrap()
    .unwrap();
    let graph = format!("[0:v]split[input][alpha];[alpha]alphaextract[mask];[input]{filter}[color];[color][mask]alphamerge[out]");
    let output = process(&rt.encoder)
        .args(["-v", "error", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", "4x2", "-i"])
        .arg(source)
        .args(["-filter_complex", &graph, "-map", "[out]", "-frames:v", "1", "-filter_complex_threads", "1", "-threads", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"])
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    assert_eq!(output.stdout.len(), pixels.len());
    for (input, actual) in pixels.chunks_exact(4).zip(output.stdout.chunks_exact(4)) {
        let expected = (0.2126 * input[0] as f64 + 0.7152 * input[1] as f64 + 0.0722 * input[2] as f64).floor() as i16;
        assert!(actual[..3].iter().all(|&channel| (channel as i16 - expected).abs() <= 1));
        assert_eq!(actual[3], input[3], "filter must retain the original alpha byte");
    }
}

#[test]
fn timeline_export_renders_clip_filter_in_final_video() {
    let temp = tempfile::tempdir().unwrap();
    let rt = runtime();
    let asset = sample(temp.path(), &rt);
    let filtered = json!({"id":"filtered","assetId":asset.id,"start":0,"trimIn":0,"trimOut":1,"speed":1,"volume":0,"opacity":1,"x":0,"y":0,"width":160,"height":120,"rotation":0,"fit":"fill","fadeIn":0,"fadeOut":0,"filters":{"enabled":true,"intensity":1,"brightness":0,"contrast":1,"saturation":0,"temperature":0,"tint":0,"sepia":0}});
    let spec = json!({"kind":"timeline","project":{"title":"filtered","width":160,"height":120,"background":"#000000","assets":[asset],"tracks":[{"kind":"video","muted":true,"clips":[filtered]}]},"config":{"format":"mp4","width":160,"height":120,"fps":20,"quality":"balanced"}});
    run(temp.path(), &rt, spec, "filtered.mp4");
    let output = process(&rt.encoder)
        .args(["-v", "error", "-ss", "0.4", "-i"])
        .arg(temp.path().join("filtered.mp4"))
        .args(["-vf", "crop=2:2:80:60,scale=1:1", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    assert_eq!(output.stdout.len(), 3);
    let rgb = output.stdout;
    assert!(rgb.iter().all(|&channel| (channel as i16 - 54).abs() <= 8), "red video should export as luma gray, got {rgb:?}");
}

#[test]
fn chroma_key_graph_multiplies_original_alpha_and_rgb_distance_mask() {
    let temp = tempfile::tempdir().unwrap();
    let rt = runtime();
    let pixels: Vec<u8> = [
        [0, 255, 0, 255],
        [255, 0, 0, 128],
        [0, 0, 255, 0],
        [0, 128, 0, 128],
        [0, 160, 0, 192],
        [40, 220, 40, 64],
        [0, 255, 0, 1],
        [100, 255, 100, 200],
    ].into_iter().flatten().collect();
    let source = temp.path().join("key-input.raw");
    fs::write(&source, &pixels).unwrap();
    for blend in [0.0, 0.08] {
        let filter = crate::chroma_key::filter_chain(
            &json!({"chromaKey":{"enabled":true,"color":"#00ff00","similarity":0.18,"blend":blend}}),
            true,
        ).unwrap().unwrap();
        let mut graph = Vec::new();
        let chain = crate::chroma_key::append_graph("[0:v]format=rgba".into(), &mut graph, 1, &filter);
        graph.push(format!("{chain}[out]"));
        let output = process(&rt.encoder)
            .args(["-v", "error", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", "4x2", "-i"])
            .arg(&source)
            .args(["-filter_complex", &graph.join(";"), "-map", "[out]", "-frames:v", "1", "-filter_complex_threads", "1", "-threads", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"])
            .output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        assert_eq!(output.stdout.len(), pixels.len());
        for (input, actual) in pixels.chunks_exact(4).zip(output.stdout.chunks_exact(4)) {
            assert_eq!(&actual[..3], &input[..3]);
            let distance = ((f64::from(input[0]).powi(2) + (f64::from(input[1]) - 255.0).powi(2) + f64::from(input[2]).powi(2)) / 3.0).sqrt() / 255.0;
            let mask = if blend == 0.0 { if distance > 0.18 { 1.0 } else { 0.0 } } else { ((distance - 0.18) / blend).clamp(0.0, 1.0) };
            let expected = (mask * f64::from(input[3])).floor() as i16;
            assert!((i16::from(actual[3]) - expected).abs() <= 1, "{input:?}: expected alpha {expected}, got {actual:?}");
        }
    }
}

#[test]
fn spill_suppression_preserves_the_native_key_alpha_and_other_color_channels() {
    let temp = tempfile::tempdir().unwrap();
    let rt = runtime();
    let pixels: Vec<u8> = [[85, 173, 35, 255], [55, 190, 29, 128], [42, 217, 208, 255], [255, 10, 30, 96], [0, 255, 0, 255], [35, 85, 173, 255], [208, 42, 217, 128], [144, 193, 72, 0]].into_iter().flatten().collect();
    let source = temp.path().join("spill-input.raw");
    fs::write(&source, &pixels).unwrap();
    for (color, channel) in [("#00ff00", 1_usize), ("#0000ff", 2_usize)] {
        let mut outputs = Vec::new();
        for spill in [false, true] {
            let filter = crate::chroma_key::filter_chain(&json!({"chromaKey":{"enabled":true,"color":color,"similarity":0.18,"blend":0.08,"spillSuppression":spill}}), true).unwrap().unwrap();
            let mut graph = Vec::new();
            let chain = crate::chroma_key::append_graph("[0:v]format=rgba".into(), &mut graph, 1, &filter);
            graph.push(format!("{chain}[out]"));
            let output = process(&rt.encoder).args(["-v", "error", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", "4x2", "-i"]).arg(&source)
                .args(["-filter_complex", &graph.join(";"), "-map", "[out]", "-frames:v", "1", "-filter_complex_threads", "1", "-threads", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"]).output().unwrap();
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
            assert_eq!(output.stdout.len(), pixels.len());
            outputs.push(output.stdout);
        }
        for ((input, legacy), actual) in pixels.chunks_exact(4).zip(outputs[0].chunks_exact(4)).zip(outputs[1].chunks_exact(4)) {
            assert_eq!(actual[3], legacy[3], "suppression must keep the exact key alpha");
            for component in 0..3 {
                let expected = if component == channel { input[component].min(input[0].max(input[if channel == 1 { 2 } else { 1 }])) } else { input[component] };
                assert_eq!(actual[component], expected, "{color} input {input:?}, actual {actual:?}");
            }
        }
    }
}

#[test]
fn timeline_export_suppresses_green_glow_in_bundled_motion_without_weakening_legacy_key() {
    let temp = tempfile::tempdir().unwrap();
    let rt = runtime();
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../public/watermarks/motion-farewell.mp4");
    let store = MediaStore::new(temp.path()).unwrap();
    let asset = store.import(&rt, &source, None).unwrap();
    let mut counts = Vec::new();
    for spill in [false, true] {
        let keyed = json!({"id":"glow","assetId":asset.id,"start":0,"trimIn":0,"trimOut":0.5,"speed":1,"volume":0,"opacity":1,"x":0,"y":0,"width":320,"height":180,"rotation":0,"fit":"fill","fadeIn":0,"fadeOut":0,
            "chromaKey":{"enabled":true,"color":"#00ff00","similarity":0.18,"blend":0.08,"spillSuppression":spill}});
        let spec = json!({"kind":"timeline","project":{"title":"glow","width":320,"height":180,"background":"#242030","assets":[asset.clone()],"tracks":[{"kind":"video","muted":true,"clips":[keyed]}]},"config":{"format":"mp4","width":320,"height":180,"fps":20,"quality":"high"}});
        let name = if spill { "glow-suppressed.mp4" } else { "glow-legacy.mp4" };
        run(temp.path(), &rt, spec, name);
        let output = process(&rt.encoder).args(["-v", "error", "-ss", "0.2", "-i"]).arg(temp.path().join(name)).args(["-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        assert_eq!(output.stdout.len(), 320 * 180 * 3);
        counts.push(output.stdout.chunks_exact(3).filter(|rgb| i16::from(rgb[1]) > i16::from(rgb[0]) + 25 && i16::from(rgb[1]) > i16::from(rgb[2]) + 25).count());
        assert!(output.stdout.chunks_exact(3).filter(|rgb| rgb.iter().any(|channel| *channel > 100)).count() > 1000, "foreground artwork must remain visible");
    }
    assert!(counts[0] > 100, "the fixture must reproduce the green-edge defect: {counts:?}");
    assert_eq!(counts[1], 0, "the rendered export must not retain strongly green edges: {counts:?}");
}

#[test]
fn timeline_export_keys_images_and_video_before_filters_and_opacity() {
    let temp = tempfile::tempdir().unwrap();
    let rt = runtime();
    let mut pixels = Vec::new();
    for y in 0..80 {
        for x in 0..80 {
            pixels.extend_from_slice(if (16..64).contains(&x) && (16..64).contains(&y) {
                if x < 40 { &[255, 0, 0, 128] } else { &[255, 0, 0, 255] }
            } else { &[0, 255, 0, 255] });
        }
    }
    let raw = temp.path().join("key-source.raw");
    let png = temp.path().join("key-source.png");
    let mov = temp.path().join("key-source.mov");
    fs::write(&raw, pixels).unwrap();
    let output = process(&rt.encoder)
        .args(["-v", "error", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", "80x80", "-i"])
        .arg(&raw)
        .args(["-frames:v", "1", "-threads", "1"])
        .arg(&png).output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let output = process(&rt.encoder)
        .args(["-v", "error", "-loop", "1", "-framerate", "20", "-i"])
        .arg(&png)
        .args(["-t", "0.5", "-c:v", "qtrle", "-pix_fmt", "argb", "-threads", "1"])
        .arg(&mov).output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let store = MediaStore::new(temp.path()).unwrap();
    for (input, name) in [(&png, "key-image.mp4"), (&mov, "key-video.mp4")] {
        let asset = store.import(&rt, input, None).unwrap();
        let keyed = json!({"id":"keyed","assetId":asset.id,"start":0,"trimIn":0,"trimOut":0.5,"speed":1,"volume":0,"opacity":0.8,"x":40,"y":20,"width":80,"height":80,"rotation":0,"fit":"fill","fadeIn":0,"fadeOut":0,
            "chromaKey":{"enabled":true,"color":"#00ff00","similarity":0.18,"blend":0.08},
            "filters":{"enabled":true,"intensity":1,"brightness":0,"contrast":1,"saturation":0,"temperature":0,"tint":0,"sepia":0}});
        let spec = json!({"kind":"timeline","project":{"title":"keyed","width":160,"height":120,"background":"#0000ff","assets":[asset],"tracks":[{"kind":"video","muted":true,"clips":[keyed]}]},"config":{"format":"mp4","width":160,"height":120,"fps":20,"quality":"high"}});
        run(temp.path(), &rt, spec, name);
        let output = process(&rt.encoder)
            .args(["-v", "error", "-ss", "0.2", "-i"])
            .arg(temp.path().join(name))
            .args(["-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
            .output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        assert_eq!(output.stdout.len(), 160 * 120 * 3);
        for (x, y, expected) in [(4, 4, [0, 0, 255]), (44, 24, [0, 0, 255]), (64, 60, [21, 21, 175]), (96, 60, [43, 43, 94])] {
            let actual = &output.stdout[(y * 160 + x) * 3..(y * 160 + x) * 3 + 3];
            assert!(actual.iter().zip(expected).all(|(&a, e)| (i16::from(a) - e).abs() <= 10), "{name} at ({x}, {y}) expected {expected:?}, got {actual:?}");
        }
    }
}

#[test]
fn timeline_composites_audio_transform_and_text_image() {
    let temp = tempfile::tempdir().unwrap();
    let rt = runtime();
    let asset = sample(temp.path(), &rt);
    let png = temp.path().join("caption.png");
    let result = process(&rt.encoder)
        .args([
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=yellow:s=60x20",
            "-frames:v",
            "1",
            "-threads",
            "1",
        ])
        .arg(&png)
        .output()
        .unwrap();
    assert!(result.status.success());
    let store = MediaStore::new(temp.path()).unwrap();
    let caption = store.import(&rt, &png, None).unwrap();
    let mut text = clip(&caption);
    text["id"] = json!("title");
    text["start"] = json!(0);
    text["trimOut"] = json!(1.2);
    text["speed"] = json!(1);
    text["rotation"] = json!(0);
    text["width"] = json!(60);
    text["height"] = json!(20);
    text["x"] = json!(30);
    text["y"] = json!(30);
    text["opacity"] = json!(1);
    text["fadeIn"] = json!(0);
    text["fadeOut"] = json!(0);
    let spec = json!({"kind":"timeline","project":{"title":"project","width":160,"height":120,"background":"#003300","assets":[asset.clone()],"tracks":[{"kind":"video","muted":false,"clips":[clip(&asset)]},{"kind":"text","muted":false,"clips":[text]}]},"config":{"format":"mp4","width":160,"height":120,"fps":20,"quality":"balanced"},"textAssets":{"title":caption}});
    let (_, probe) = run(temp.path(), &rt, spec, "timeline.mp4");
    assert_eq!(probe["streams"][0]["width"], 160);
    let duration = probe["format"]["duration"]
        .as_str()
        .unwrap()
        .parse::<f64>()
        .unwrap();
    assert!((duration - 1.2).abs() < 0.15);
    assert!(probe["streams"]
        .as_array()
        .unwrap()
        .iter()
        .any(|s| s["codec_type"] == "audio"));
    let pixels = process(&rt.encoder)
        .args(["-v", "error", "-ss", "0.6", "-i"])
        .arg(temp.path().join("timeline.mp4"))
        .args([
            "-vf",
            "crop=2:2:40:40,scale=1:1",
            "-frames:v",
            "1",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-",
        ])
        .output()
        .unwrap();
    assert!(pixels.status.success());
    assert!(
        pixels.stdout[0] > 180 && pixels.stdout[1] > 180 && pixels.stdout[2] < 70,
        "foreground caption expected yellow, got {:?}",
        pixels.stdout
    );
}
#[test]
fn cancelling_output_preserves_existing_file() {
    let temp = tempfile::tempdir().unwrap();
    let rt = runtime();
    let jobs = JobManager::default();
    let target = temp.path().join("existing.mp4");
    fs::write(&target, b"original-file").unwrap();
    let plan = RenderPlan {
        video: None,
        args: vec![
            "-f".into(),
            "lavfi".into(),
            "-i".into(),
            "testsrc2=s=1920x1080:r=30:d=300".into(),
            "-c:v".into(),
            "libx264".into(),
            "-preset".into(),
            "slow".into(),
        ],
        duration: 300.0,
        format: "mp4".into(),
        workspace: tempfile::tempdir().unwrap(),
    };
    let job = jobs.begin(&rt, plan, target.clone()).unwrap();
    jobs.cancel(&job.id).unwrap();
    assert_eq!(wait(&jobs, &job.id).state, "cancelled");
    assert_eq!(fs::read(target).unwrap(), b"original-file");
}
#[test]
fn validates_ranges_and_malformed_jobs() {
    let temp = tempfile::tempdir().unwrap();
    let store = MediaStore::new(temp.path()).unwrap();
    let rt = runtime();
    assert!(build_plan(&store, &rt, &json!({"kind":"shell","command":"bad"})).is_err());
    assert!(number(&json!({"fps":500}), "fps", 30.0, 1.0, 120.0).is_err());
    assert!(
        suggested_output(&json!({"kind":"convert","asset":{"name":"x"},"format":"exe"})).is_err()
    );
}
#[test]
fn capture_device_parsing_distinguishes_screen_and_microphone() {
    let mac="[AVFoundation indev @ 0] AVFoundation video devices:\n[AVFoundation indev @ 0] [0] Camera\n[AVFoundation indev @ 0] [1] Capture screen 0\n[AVFoundation indev @ 0] AVFoundation audio devices:\n[AVFoundation indev @ 0] [0] Built-in Microphone";
    let devices = parse_devices(mac, true);
    assert_eq!(devices.len(), 2);
    assert_eq!(devices[0].id, "1");
    assert_eq!(devices[0].kind, "screen");
    assert_eq!(devices[1].kind, "audio");
    let devices = parse_devices(
        "[dshow @ 0] \"Mic\" (audio)\n[dshow @ 0] Alternative name \"@device\"",
        false,
    );
    assert_eq!(devices.len(), 1);
    assert_eq!(devices[0].name, "Mic");
}

#[test]
fn muted_video_keeps_picture_and_overlapping_fades() {
    let temp = tempfile::tempdir().unwrap();
    let rt = runtime();
    let asset = sample(temp.path(), &rt);
    let mut faded = clip(&asset);
    faded["fadeIn"] = json!(1.0);
    faded["fadeOut"] = json!(1.0);
    let (_, probe) = run(
        temp.path(),
        &rt,
        json!({"kind":"timeline","project":{"width":160,"height":120,"background":"#000000","assets":[asset.clone()],"tracks":[{"kind":"video","muted":true,"clips":[faded]}]},"config":{"format":"mp4","width":160,"height":120,"fps":20,"quality":"draft"}}),
        "muted.mp4",
    );
    assert!(probe["streams"]
        .as_array()
        .unwrap()
        .iter()
        .any(|s| s["codec_type"] == "video"));
    assert!(!probe["streams"]
        .as_array()
        .unwrap()
        .iter()
        .any(|s| s["codec_type"] == "audio"));
    let pixels = process(&rt.encoder)
        .args(["-v", "error", "-ss", "0.4", "-i"])
        .arg(temp.path().join("muted.mp4"))
        .args([
            "-vf",
            "crop=2:2:70:50,scale=1:1",
            "-frames:v",
            "1",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-",
        ])
        .output()
        .unwrap();
    assert!(
        pixels.stdout[0] >= 25 && pixels.stdout[0] <= 60,
        "muting retains the picture, and overlapping fades follow the preview envelope: {:?}",
        pixels.stdout
    );
}

#[test]
fn container_encoders_and_odd_image_dimensions() {
    let temp = tempfile::tempdir().unwrap();
    let rt = runtime();
    let asset = sample(temp.path(), &rt);
    for format in ["webm", "mov", "mkv", "mp3", "aac", "flac"] {
        let (_, probe) = run(
            temp.path(),
            &rt,
            json!({"kind":"convert","asset":asset,"format":format,"trimStart":0,"trimEnd":0.4,"width":80,"fps":10}),
            &format!("codec.{format}"),
        );
        assert!(!probe["streams"].as_array().unwrap().is_empty());
    }
    let input = temp.path().join("odd.png");
    let output = process(&rt.encoder)
        .args([
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc=s=17x19",
            "-frames:v",
            "1",
            "-threads",
            "1",
        ])
        .arg(&input)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let image = MediaStore::new(temp.path())
        .unwrap()
        .import(&rt, &input, None)
        .unwrap();
    for format in ["png", "jpg", "webp", "bmp", "tiff"] {
        let (_, probe) = run(
            temp.path(),
            &rt,
            json!({"kind":"convert","asset":image,"format":format}),
            &format!("odd-output.{format}"),
        );
        assert_eq!(probe["streams"][0]["width"], 17);
        assert_eq!(probe["streams"][0]["height"], 19);
    }
}

#[test]
fn live_recording_without_duration_uses_packet_timestamps() {
    let temp = tempfile::tempdir().unwrap();
    let rt = runtime();
    let original = sample(temp.path(), &rt);
    let recording = temp.path().join("live-recording.webm");
    let result = process(&rt.encoder)
        .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
        .arg(&original.native_path)
        .args([
            "-c:v",
            "libvpx-vp9",
            "-deadline",
            "realtime",
            "-cpu-used",
            "8",
            "-c:a",
            "libopus",
            "-live",
            "1",
        ])
        .arg(&recording)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let metadata = process(&rt.probe)
        .args([
            "-v",
            "error",
            "-show_format",
            "-show_streams",
            "-of",
            "json",
        ])
        .arg(&recording)
        .output()
        .unwrap();
    let metadata: Value = serde_json::from_slice(&metadata.stdout).unwrap();
    assert!(
        metadata["format"]["duration"].is_null(),
        "fixture must lack format duration"
    );
    assert!(
        metadata["streams"]
            .as_array()
            .unwrap()
            .iter()
            .all(|stream| stream["duration"].is_null()),
        "fixture must lack stream duration"
    );
    let imported = MediaStore::new(temp.path())
        .unwrap()
        .import(&rt, &recording, None)
        .unwrap();
    assert!(
        (imported.duration - 2.0).abs() < 0.1,
        "duration {}",
        imported.duration
    );
    assert_eq!(imported.kind, "video");
    let (_, converted) = run(
        temp.path(),
        &rt,
        json!({"kind":"convert","asset": imported,"format":"mp4","trimStart":0.25,"trimEnd":1.25}),
        "live-export.mp4",
    );
    let duration = converted["format"]["duration"]
        .as_str()
        .unwrap()
        .parse::<f64>()
        .unwrap();
    assert!((duration - 1.0).abs() < 0.15);
}

#[test]
fn portrait_rotation_reports_display_dimensions() {
    let temp = tempfile::tempdir().unwrap();
    let rt = runtime();
    let original = sample(temp.path(), &rt);
    for rotation in [90, 270] {
        let portrait = temp.path().join(format!("portrait-{rotation}.mp4"));
        let result = process(&rt.encoder)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-display_rotation:v:0",
                &rotation.to_string(),
                "-i",
            ])
            .arg(&original.native_path)
            .args(["-c", "copy"])
            .arg(&portrait)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let imported = MediaStore::new(temp.path())
            .unwrap()
            .import(&rt, &portrait, None)
            .unwrap();
        assert_eq!(
            (imported.width, imported.height),
            (120, 160),
            "display orientation {rotation}"
        );
        assert_eq!(
            fs::read(&imported.native_path).unwrap(),
            fs::read(&portrait).unwrap(),
            "import must preserve original media and metadata"
        );
    }
}

#[test]
fn shutdown_waits_for_encoder_cancellation_without_replacing_output() {
    let temp = tempfile::tempdir().unwrap();
    let rt = runtime();
    let jobs = JobManager::default();
    let target = temp.path().join("shutdown.mp4");
    fs::write(&target, b"existing-output").unwrap();
    let plan = RenderPlan {
        video: None,
        args: vec![
            "-f".into(),
            "lavfi".into(),
            "-i".into(),
            "testsrc2=s=640x480:r=30:d=300".into(),
            "-c:v".into(),
            "libx264".into(),
            "-preset".into(),
            "slow".into(),
        ],
        duration: 300.0,
        format: "mp4".into(),
        workspace: tempfile::tempdir().unwrap(),
    };
    let job = jobs.begin(&rt, plan, target.clone()).unwrap();
    jobs.shutdown();
    let final_job = jobs
        .list()
        .into_iter()
        .find(|entry| entry.id == job.id)
        .unwrap();
    assert_eq!(
        final_job.state, "cancelled",
        "shutdown must finish cancellation before returning"
    );
    assert_eq!(fs::read(target).unwrap(), b"existing-output");
}

#[test]
fn timeline_split_preserves_every_decoded_frame_across_fractional_boundaries() {
    let temp = tempfile::tempdir().unwrap();
    let rt = runtime();
    let source = temp.path().join("continuous-source.mp4");
    let created = process(&rt.encoder)
        .args(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0xe04020:s=160x96:r=25:d=3", "-c:v", "libx264", "-pix_fmt", "yuv420p"])
        .arg(&source).output().unwrap();
    assert!(created.status.success(), "{}", String::from_utf8_lossy(&created.stderr));
    let asset = MediaStore::new(temp.path()).unwrap().import(&rt, &source, None).unwrap();
    for (index, (fps, speed, boundary, gap)) in [(30.0, 1.0, 0.713, 0.0), (30.0, 1.25, 0.713, 0.0), (24.0, 1.3, 0.7, 0.0), (30.0, 1.0, 0.713, 0.3)].into_iter().enumerate() {
        let cut = 0.137 + boundary * speed;
        let visual = |id: &str, start: f64, trim_in: f64, trim_out: f64| json!({"id":id,"assetId":asset.id,"start":start,"trimIn":trim_in,"trimOut":trim_out,"speed":speed,"width":160,"height":96,"volume":0,"fadeIn":0,"fadeOut":0});
        let spec = json!({"kind":"timeline","project":{"width":160,"height":96,"background":"#0000ff","assets":[asset.clone()],"tracks":[{"kind":"video","muted":true,"clips":[visual("left",0.0,0.137,cut),visual("right",boundary+gap,cut,2.537)]}]},"config":{"format":"mp4","width":160,"height":96,"fps":fps,"quality":"high"}});
        let name = format!("split-{index}.mp4");
        run(temp.path(), &rt, spec, &name);
        let decoded = process(&rt.encoder).args(["-v", "error", "-i"]).arg(temp.path().join(name))
            .args(["-vf", "crop=2:2:80:48,scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).output().unwrap();
        assert!(decoded.status.success(), "{}", String::from_utf8_lossy(&decoded.stderr));
        assert!(decoded.stdout.len() / 3 >= (((2.4 / speed + gap) * fps).floor() as usize));
        for (frame, pixel) in decoded.stdout.chunks_exact(3).enumerate() {
            let time = frame as f64 / fps;
            if gap > 0.0 && time >= boundary && time < boundary + gap {
                assert!(pixel[2] > 150 && pixel[0] < 50, "holding the final decoded frame must not extend the clip across an intentional gap: frame={frame}, pixel={pixel:?}");
            } else {
                assert!(pixel[0] > 150 && pixel[1] < 100, "native split background frame {frame} at {time}s, fps={fps}, speed={speed}, split={boundary}, pixel={pixel:?}");
            }
        }
    }
}

fn transition_spec(asset: &Asset, effect: &str) -> Value {
    let visual = |id: &str, start: f64, trim_in: f64, trim_out: f64| json!({
        "id":id,"assetId":asset.id,"start":start,"trimIn":trim_in,"trimOut":trim_out,
        "speed":1,"width":160,"height":120,"volume":0,"fadeIn":0,"fadeOut":0
    });
    json!({"kind":"timeline","project":{
        "width":160,"height":120,"background":"#00ff00","assets":[asset],
        "tracks":[
            {"kind":"transition","clips":[{"id":"transition","start":0.6,"trimIn":0,"trimOut":0.8,"speed":1,"transition":{"effect":effect,"fromClipId":"left","toClipId":"right"}}]},
            {"kind":"video","muted":true,"clips":[visual("left",0.0,0.0,1.0),visual("right",1.0,1.0,2.0)]}
        ]
    },"config":{"format":"mp4","width":160,"height":120,"fps":20,"quality":"high"}})
}

fn decoded_video(runtime: &Runtime, path: &Path) -> Vec<u8> {
    let decoded = process(&runtime.encoder).args(["-v", "error", "-i"]).arg(path)
        .args(["-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).output().unwrap();
    assert!(decoded.status.success(), "{}", String::from_utf8_lossy(&decoded.stderr));
    decoded.stdout
}

#[test]
fn timeline_exports_ten_centered_transition_effects_without_changing_duration() {
    let temp = tempfile::tempdir().unwrap();
    let rt = runtime();
    let asset = sample(temp.path(), &rt);
    let frame_size = 160 * 120 * 3;
    for effect in ["fade", "wipe-up", "wipe-down", "wipe-left", "wipe-right", "close-vertical", "close-horizontal", "slide-left", "slide-right", "zoom"] {
        let filename = format!("transition-{effect}.mp4");
        let (_, probe) = run(temp.path(), &rt, transition_spec(&asset, effect), &filename);
        let duration: f64 = probe["format"]["duration"].as_str().unwrap().parse().unwrap();
        assert!((duration - 2.0).abs() < 0.01, "{effect}: transition changed duration to {duration}");
        let decoded = decoded_video(&rt, &temp.path().join(&filename));
        assert_eq!(decoded.len(), 40 * frame_size, "{effect}: dropped output frames");
        for (index, frame) in decoded.chunks_exact(frame_size).enumerate() {
            let center = &frame[(60 * 160 + 80) * 3..][..3];
            if index < 12 {
                assert!(center[0] > 220 && center[1] < 25, "{effect}: unexpected background before transition at {index}: {center:?}");
            }
            if index >= 28 {
                assert!(center[2] > 220 && center[1] < 25, "{effect}: unexpected background after transition at {index}: {center:?}");
            }
            // The intentional midpoint reveals the configured green background,
            // not an extra black frame caused by the source clip ending.
            if index == 20 {
                assert!(center[1] > 220 && center[0] < 25 && center[2] < 25, "{effect}: incorrect cut frame {center:?}");
            }
            assert!(frame.chunks_exact(3).all(|pixel| pixel.iter().any(|value| *value > 45)), "{effect}: introduced black pixels at {index}");
        }
        for (index, source_channel) in [(16, 0), (24, 2)] {
            let frame = &decoded[index * frame_size..(index + 1) * frame_size];
            let average = |channel: usize| frame.chunks_exact(3).map(|pixel| pixel[channel] as f64).sum::<f64>() / (160.0 * 120.0);
            if effect == "fade" {
                assert!((average(source_channel) - 127.0).abs() < 20.0 && (average(1) - 127.0).abs() < 20.0, "{effect}: incorrect half opacity at frame {index}");
            } else if effect == "zoom" {
                assert!((average(source_channel) - 32.0).abs() < 15.0 && average(1) > 205.0, "{effect}: incorrect centered scale at frame {index}");
            } else {
                assert!((average(source_channel) - 127.0).abs() < 25.0 && (average(1) - 127.0).abs() < 25.0, "{effect}: incorrect half coverage at frame {index}: {} {}", average(source_channel), average(1));
            }
            let checks: &[(usize, usize, bool)] = match effect {
                "wipe-up" => &[(40, 20, false), (40, 100, true)],
                "wipe-down" => &[(40, 20, true), (40, 100, false)],
                "wipe-left" | "slide-right" => &[(20, 40, false), (140, 40, true)],
                "wipe-right" | "slide-left" => &[(20, 40, true), (140, 40, false)],
                "close-vertical" => &[(20, 60, true), (80, 20, false), (80, 100, false)],
                "close-horizontal" => &[(80, 20, true), (20, 60, false), (140, 60, false)],
                _ => &[],
            };
            for &(x, y, visible) in checks {
                let pixel = &frame[(y * 160 + x) * 3..][..3];
                assert!(if visible { pixel[source_channel] > 220 && pixel[1] < 25 } else { pixel[1] > 220 && pixel[source_channel] < 25 }, "{effect}: wrong direction at ({x}, {y}), frame {index}: {pixel:?}");
            }
        }
    }
}

fn verify_explainer_transition_exports(effects: &[&str]) {
    let temp = tempfile::tempdir().unwrap();
    let rt = runtime();
    let asset = sample(temp.path(), &rt);
    let width = 240;
    let height = 180;
    let frame_size = width * height * 3;
    for &effect in effects {
        let mut spec = transition_spec(&asset, effect);
        for field in ["project", "config"] {
            spec[field]["width"] = json!(width);
            spec[field]["height"] = json!(height);
        }
        for clip in spec["project"]["tracks"][1]["clips"].as_array_mut().unwrap() {
            clip["x"] = json!(40);
            clip["y"] = json!(30);
        }
        let filename = format!("explainer-{effect}.mp4");
        let (_, probe) = run(temp.path(), &rt, spec, &filename);
        let duration: f64 = probe["format"]["duration"].as_str().unwrap().parse().unwrap();
        assert!((duration - 2.0).abs() < 0.01, "{effect}: altered timeline duration");
        let decoded = decoded_video(&rt, &temp.path().join(filename));
        assert_eq!(decoded.len(), 40 * frame_size, "{effect}: dropped decoded frames");
        let pixel = |frame: usize, x: usize, y: usize| &decoded[frame * frame_size + (y * width + x) * 3..][..3];
        for frame in 0..40 {
            for (x, y) in [(20, 90), (220, 90), (120, 10), (120, 170)] {
                let p = pixel(frame, x, y);
                assert!(p[1] > 230 && p[0] < 15 && p[2] < 15,
                    "{effect}: leaked outside positioned clip at frame {frame}: {p:?}");
            }
        }
        for (frame, channel) in [(8, 0), (32, 2)] {
            let p = pixel(frame, 120, 90);
            assert!(p[channel] > 230 && p[1] < 15, "{effect}: changed a frame outside transition: {p:?}");
        }
        let cut = pixel(20, 120, 90);
        if effect == "flash-white" {
            assert!(cut[0] > 240 && cut[1] > 235 && (cut[2] as i32 - 232).abs() < 15,
                "flash cut must use warm white: {cut:?}");
        } else {
            assert!(cut[1] > 230 && cut[0] < 15 && cut[2] < 15,
                "{effect}: midpoint must reveal project background: {cut:?}");
        }
        for (frame, channel) in [(16, 0), (24, 2)] {
            let center = pixel(frame, 120, 90);
            if matches!(effect, "defocus" | "zoom-through") {
                assert!((center[channel] as i32 - 127).abs() < 16 && (center[1] as i32 - 127).abs() < 16,
                    "{effect}: opacity must be half at quarter-transition: {center:?}");
            } else if effect == "flash-white" {
                assert!(center[channel] > 235 && (center[1] as i32 - 124).abs() < 16,
                    "flash must mix the source with ivory, not project green: {center:?}");
            } else {
                let checks: &[(usize, usize, bool)] = match effect {
                    "iris" => &[(80, 60, true), (110, 90, true), (125, 105, false), (12, 60, false)],
                    "diamond" => &[(80, 60, true), (100, 75, true), (120, 100, false), (10, 5, false)],
                    "blinds" => &[(80, 4, true), (80, 12, false), (80, 108, true), (80, 114, false)],
                    "diagonal" => &[(20, 20, true), (70, 30, true), (140, 100, false), (100, 100, false)],
                    "radial" => &[(120, 30, true), (120, 90, true), (40, 90, false), (40, 30, false)],
                    _ => &[],
                };
                for &(x, y, visible) in checks {
                    let p = pixel(frame, 40 + x, 30 + y);
                    assert!(if visible { p[channel] > 220 && p[1] < 25 } else { p[1] > 220 && p[channel] < 25 },
                        "{effect}: incorrect mask at ({x},{y}) frame {frame}: {p:?}");
                }
            }
        }
        if matches!(effect, "diagonal" | "radial") {
            let checks = if effect == "diagonal" { [(20, 20, true), (70, 30, false)] }
                else { [(110, 30, true), (110, 90, false)] };
            for (frame, channel) in [(18, 0), (22, 2)] {
                for (x, y, visible) in checks {
                    let p = pixel(frame, 40 + x, 30 + y);
                    assert!(if visible { p[channel] > 220 && p[1] < 25 } else { p[1] > 220 && p[channel] < 25 },
                        "{effect}: wrong quarter opening at ({x},{y}) frame {frame}: {p:?}");
                }
            }
        }
    }
}

#[test]
fn explainer_transitions_export_distinct_masks_color_and_clip_local_motion() {
    verify_explainer_transition_exports(&["iris", "diamond", "blinds", "flash-white", "defocus", "zoom-through"]);
}

fn verify_explainer_transition_ranges(effects: &[&str]) {
    let temp = tempfile::tempdir().unwrap();
    let rt = runtime();
    let asset = sample(temp.path(), &rt);
    let store = MediaStore::new(temp.path()).unwrap();
    let jobs = JobManager::default();
    let frame_size = 160 * 120 * 3;
    for &effect in effects {
        let mut project = transition_spec(&asset, effect)["project"].clone();
        project["fps"] = json!(20);
        for track in project["tracks"].as_array_mut().unwrap() {
            for clip in track["clips"].as_array_mut().unwrap() {
                clip["start"] = json!(clip["start"].as_f64().unwrap() + 4.0);
            }
        }
        let mut spec = json!({"project":project,"start":4.75,"end":5.25,"width":160,"fps":20});
        let job = crate::preview_tools::begin(&store, &rt, &jobs, &spec).unwrap();
        let finished = wait(&jobs, &job.id);
        assert_eq!(finished.state, "completed", "{effect}: {:?}", finished.error);
        let result = crate::preview_tools::result(&store, &rt, &jobs, &job.id).unwrap();
        assert!((result.duration - 0.5).abs() < 0.01);
        let video = decoded_video(&rt, Path::new(&result.native_path));
        assert_eq!(video.len(), 10 * frame_size, "{effect}: range has wrong number of frames");
        crate::preview_tools::discard(&store, &jobs, &job.id).unwrap();
        spec["frameOnly"] = json!(true);
        for (frame, time) in [(1, 4.8), (5, 5.0), (9, 5.2)] {
            spec["start"] = json!(time);
            let job = crate::preview_tools::begin(&store, &rt, &jobs, &spec).unwrap();
            let finished = wait(&jobs, &job.id);
            assert_eq!(finished.state, "completed", "{effect}: {:?}", finished.error);
            let result = crate::preview_tools::result(&store, &rt, &jobs, &job.id).unwrap();
            let image = decoded_video(&rt, Path::new(&result.native_path));
            assert_eq!(image.len(), frame_size);
            let expected = &video[frame * frame_size..(frame + 1) * frame_size];
            let average_error = image.iter().zip(expected).map(|(a,b)| (*a as f64-*b as f64).abs()).sum::<f64>() / frame_size as f64;
            // The range uses 4:2:0 video. Eight narrow, saturated strips put far
            // more pixels on chroma boundaries than the other masks, so compare
            // their interiors separately from the encoded edge pixels.
            let tolerance = if effect == "blinds" { 18.0 } else { 5.0 };
            assert!(average_error < tolerance, "{effect}: exact frame/range disagree at {time}: mean error {average_error}");
            if effect == "blinds" {
                let visibility = ((time - 5.0_f64).abs() / 0.4).clamp(0.0, 1.0);
                for y in 0..120 {
                    let row = y / 15;
                    let local = (y % 15) as f64;
                    let opening = ((visibility - 0.22 * row as f64 / 7.0) / 0.78).clamp(0.0, 1.0) * 15.0;
                    if local > 2.0 && local < 12.0 && (local - opening).abs() > 2.0 {
                        let offset = (y * 160 + 80) * 3;
                        let channel = if time < 5.0 { 0 } else { 2 };
                        let visible = local < opening;
                        assert_eq!(image[offset + channel] > image[offset + 1], visible,
                            "blinds: incorrect still mask at {time}, row {y}");
                        assert_eq!(expected[offset + channel] > expected[offset + 1], visible,
                            "blinds: incorrect video mask at {time}, row {y}");
                    }
                }
            }
            crate::preview_tools::discard(&store, &jobs, &job.id).unwrap();
        }
    }
}

#[test]
fn explainer_transition_range_and_exact_frames_match_export_global_clock() {
    verify_explainer_transition_ranges(&["iris", "diamond", "blinds", "flash-white", "defocus", "zoom-through"]);
}

#[test]
fn explainer_diagonal_and_radial_masks_export_video_ranges_and_exact_frames() {
    verify_explainer_transition_exports(&["diagonal", "radial"]);
    verify_explainer_transition_ranges(&["diagonal", "radial"]);
}

#[test]
fn explainer_defocus_scales_in_previews_and_zoom_through_moves_source_detail() {
    let temp = tempfile::tempdir().unwrap();
    let rt = runtime();
    let source = temp.path().join("detail-source.mp4");
    let created = process(&rt.encoder).args(["-v", "error", "-y", "-f", "lavfi", "-i",
        "color=red:s=160x120:r=20:d=2,drawbox=x=80:y=0:w=80:h=120:color=blue:t=fill,drawbox=x=32:y=0:w=8:h=120:color=white:t=fill",
        "-c:v", "libx264", "-pix_fmt", "yuv420p"]).arg(&source).output().unwrap();
    assert!(created.status.success(), "{}", String::from_utf8_lossy(&created.stderr));
    let store = MediaStore::new(temp.path()).unwrap();
    let asset = store.import(&rt, &source, None).unwrap();
    let jobs = JobManager::default();
    let frame = |effect: &str, blur: Option<f64>, width: usize| {
        let mut project = transition_spec(&asset, effect)["project"].clone();
        project["fps"] = json!(20);
        if let Some(blur) = blur { project["tracks"][0]["clips"][0]["transition"]["blur"] = json!(blur); }
        let spec = json!({"project":project,"start":0.8,"frameOnly":true,"width":width});
        let job = crate::preview_tools::begin(&store, &rt, &jobs, &spec).unwrap();
        let finished = wait(&jobs, &job.id);
        assert_eq!(finished.state, "completed", "{effect}: {:?}", finished.error);
        let result = crate::preview_tools::result(&store, &rt, &jobs, &job.id).unwrap();
        let bytes = decoded_video(&rt, Path::new(&result.native_path));
        assert_eq!(bytes.len(), width * (width * 3 / 4) * 3);
        crate::preview_tools::discard(&store, &jobs, &job.id).unwrap();
        bytes
    };
    for width in [160, 80] {
        let original = frame("defocus", Some(0.0), width);
        let softened = frame("defocus", None, width);
        let point = (60 * width / 160 * width + 72 * width / 160) * 3;
        assert!(original[point + 2] < 8, "explicit zero should disable focus blur");
        assert!(softened[point + 2] > 10 && softened[point + 2] < 35,
            "focus default must mix boundary colors consistently at width {width}: {:?}", &softened[point..point + 3]);
    }
    let zoomed = frame("zoom-through", None, 160);
    let occupied: Vec<_> = (0..70).filter(|x| zoomed[(60 * 160 + *x) * 3 + 1] > 220).collect();
    assert!(!occupied.is_empty(), "camera push lost the source marker");
    assert!((occupied[0] as i32 - 29).abs() <= 1,
        "camera push must sample a 1.06x source at half visibility, not just fade: {occupied:?}");
    assert!((occupied.last().copied().unwrap() as i32 - 37).abs() <= 1,
        "camera push resized its source marker incorrectly: {occupied:?}");
}

#[test]
fn explainer_transition_rotation_and_parameter_overrides_are_preserved() {
    let temp = tempfile::tempdir().unwrap();
    let rt = runtime();
    let asset = sample(temp.path(), &rt);
    let store = MediaStore::new(temp.path()).unwrap();
    let jobs = JobManager::default();
    let mut project = transition_spec(&asset, "diamond")["project"].clone();
    project["width"] = json!(240);
    project["height"] = json!(180);
    for clip in project["tracks"][1]["clips"].as_array_mut().unwrap() {
        clip["x"] = json!(40);
        clip["y"] = json!(30);
        clip["rotation"] = json!(90);
    }
    let frame = |project: &Value, time: f64| {
        let job = crate::preview_tools::begin(&store, &rt, &jobs,
            &json!({"project":project,"start":time,"frameOnly":true,"width":240})).unwrap();
        let finished = wait(&jobs, &job.id);
        assert_eq!(finished.state, "completed", "{:?}", finished.error);
        let result = crate::preview_tools::result(&store, &rt, &jobs, &job.id).unwrap();
        let bytes = decoded_video(&rt, Path::new(&result.native_path));
        assert_eq!(bytes.len(), 240 * 180 * 3);
        crate::preview_tools::discard(&store, &jobs, &job.id).unwrap();
        bytes
    };
    let bytes = frame(&project, 0.8);
    let inside = &bytes[(155 * 240 + 120) * 3..][..3];
    let outside = &bytes[(90 * 240 + 185) * 3..][..3];
    assert!(inside[0] > 220 && inside[1] < 25,
        "diamond must rotate with its positioned clip, not in project coordinates: {inside:?}");
    assert!(outside[1] > 220 && outside[0] < 25,
        "rotated diamond must keep its narrow local axis: {outside:?}");
    project["tracks"][0]["clips"][0]["transition"] = json!({
        "effect":"flash-white","fromClipId":"left","toClipId":"right",
        "color":"#8040ff","easing":"ease-in","scope":"outgoing"
    });
    let bytes = frame(&project, 0.8);
    let center = &bytes[(90 * 240 + 120) * 3..][..3];
    for (actual, expected) in center.iter().zip([160, 48, 191]) {
        assert!((*actual as i32 - expected).abs() < 10, "flash must honor custom color/easing: {center:?}");
    }
    let bytes = frame(&project, 1.0);
    let center = &bytes[(90 * 240 + 120) * 3..][..3];
    assert!(center[2] > 220 && center[0] < 25 && center[1] < 25,
        "outgoing-only flash must leave the incoming clip unchanged: {center:?}");
}

#[test]
fn gentle_zoom_fades_export_eighty_percent_scale_fixed_anchors_and_independent_opacity() {
    let temp = tempfile::tempdir().unwrap();
    let rt = runtime();
    let asset = sample(temp.path(), &rt);
    let width = 240;
    let height = 180;
    let frame_size = width * height * 3;
    for (effect, anchor_x, anchor_y) in [
        ("zoom-fade", 0.5, 0.5),
        ("zoom-fade-left", 0.0, 0.5),
        ("zoom-fade-right", 1.0, 0.5),
        ("zoom-fade-up", 0.5, 0.0),
        ("zoom-fade-down", 0.5, 1.0),
    ] {
        let mut spec = transition_spec(&asset, effect);
        spec["project"]["width"] = json!(width);
        spec["project"]["height"] = json!(height);
        spec["config"]["width"] = json!(width);
        spec["config"]["height"] = json!(height);
        // A direction left over from a different preset must not override
        // these presets' anchors. Non-origin clips must retain their position.
        spec["project"]["tracks"][0]["clips"][0]["transition"]["direction"] = json!("down");
        for clip in spec["project"]["tracks"][1]["clips"].as_array_mut().unwrap() {
            clip["x"] = json!(40);
            clip["y"] = json!(30);
        }
        let filename = format!("gentle-{effect}.mp4");
        let (_, probe) = run(temp.path(), &rt, spec, &filename);
        let duration: f64 = probe["format"]["duration"].as_str().unwrap().parse().unwrap();
        assert!((duration - 2.0).abs() < 0.01, "{effect}: changed source timing");
        let decoded = decoded_video(&rt, &temp.path().join(filename));
        assert_eq!(decoded.len(), 40 * frame_size, "{effect}: dropped output frames");
        for (frame_number, channel, visibility) in [
            (8, 0, 1.0),
            (14, 0, 0.75),
            (16, 0, 0.5),
            (18, 0, 0.25),
            (20, 2, 0.0),
            (22, 2, 0.25),
            (24, 2, 0.5),
            (26, 2, 0.75),
            (32, 2, 1.0),
        ] {
            let frame = &decoded[frame_number * frame_size..(frame_number + 1) * frame_size];
            let pixel = |x: usize, y: usize| &frame[(y * width + x) * 3..][..3];
            let center = pixel(120, 90);
            assert!((center[channel] as f64 - 255.0 * visibility).abs() < 15.0,
                "{effect}: opacity at frame {frame_number} is {center:?}, expected {visibility}");
            assert!((center[1] as f64 - 255.0 * (1.0 - visibility)).abs() < 15.0,
                "{effect}: background blend at frame {frame_number} is {center:?}");
            // Far outside the original clip rectangle stays green throughout.
            for (x, y) in [(20, 90), (220, 90), (120, 10), (120, 170)] {
                let outside = pixel(x, y);
                assert!(outside[1] > 230 && outside[channel] < 15,
                    "{effect}: changed clip placement at ({x}, {y}): {outside:?}");
            }
            if visibility == 0.0 {
                assert!(frame.chunks_exact(3).all(|p| p[1] > 230 && p[channel] < 15),
                    "{effect}: midpoint is not fully transparent");
                continue;
            }
            let scale = 0.8 + 0.2 * visibility;
            let expected_left = 40.0 + 160.0 * (1.0 - scale) * anchor_x;
            let expected_top = 30.0 + 120.0 * (1.0 - scale) * anchor_y;
            let expected_right = expected_left + 160.0 * scale;
            let expected_bottom = expected_top + 120.0 * scale;
            let threshold = (255.0 * visibility * 0.5) as u8;
            let horizontal: Vec<_> = (0..width).filter(|x| pixel(*x, 90)[channel] > threshold).collect();
            let vertical: Vec<_> = (0..height).filter(|y| pixel(120, *y)[channel] > threshold).collect();
            let actual = [horizontal[0] as f64, (horizontal.last().unwrap() + 1) as f64,
                vertical[0] as f64, (vertical.last().unwrap() + 1) as f64];
            let expected = [expected_left, expected_right, expected_top, expected_bottom];
            for (measured, wanted) in actual.into_iter().zip(expected) {
                assert!((measured - wanted).abs() <= 2.0,
                    "{effect}: wrong 80%–100% scale/anchor at frame {frame_number}: {actual:?}, expected {expected:?}");
            }
        }
    }
}

#[test]
fn gentle_zoom_fade_range_and_exact_frame_use_global_transition_clock() {
    let temp = tempfile::tempdir().unwrap();
    let rt = runtime();
    let asset = sample(temp.path(), &rt);
    let store = MediaStore::new(temp.path()).unwrap();
    let jobs = JobManager::default();
    let mut project = transition_spec(&asset, "zoom-fade-right")["project"].clone();
    project["fps"] = json!(20);
    project["tracks"][0]["clips"][0]["transition"]["easing"] = json!("ease-in");
    for track in project["tracks"].as_array_mut().unwrap() {
        for clip in track["clips"].as_array_mut().unwrap() {
            clip["start"] = json!(clip["start"].as_f64().unwrap() + 4.0);
        }
    }
    let check = |frame: &[u8], time: f64| {
        let channel = if time < 5.0 { 0 } else { 2 };
        let visibility = ((time - 5.0).abs() / 0.4).clamp(0.0, 1.0).powi(2);
        let center = &frame[(60 * 160 + 80) * 3..][..3];
        assert!((center[channel] as f64 - 255.0 * visibility).abs() < 15.0,
            "range/frame lost easing or global time at {time}: {center:?}, expected visibility {visibility}");
        if visibility > 0.05 {
            let threshold = (255.0 * visibility * 0.5) as u8;
            let occupied: Vec<_> = (0..160).filter(|x| frame[(60 * 160 + *x) * 3 + channel] > threshold).collect();
            let expected_left = 160.0 * 0.2 * (1.0 - visibility);
            assert!((occupied[0] as f64 - expected_left).abs() <= 2.0,
                "range/frame lost gentle scale at {time}: left {}, expected {expected_left}", occupied[0]);
            assert_eq!(occupied.last(), Some(&159), "right anchor moved at {time}");
        }
    };
    let mut spec = json!({"project":project,"start":4.75,"end":5.25,"width":160,"fps":20});
    let job = crate::preview_tools::begin(&store, &rt, &jobs, &spec).unwrap();
    assert_eq!(wait(&jobs, &job.id).state, "completed");
    let result = crate::preview_tools::result(&store, &rt, &jobs, &job.id).unwrap();
    assert!((result.duration - 0.5).abs() < 0.01);
    let decoded = decoded_video(&rt, Path::new(&result.native_path));
    assert_eq!(decoded.len(), 10 * 160 * 120 * 3);
    for (index, frame) in decoded.chunks_exact(160 * 120 * 3).enumerate() {
        check(frame, 4.75 + index as f64 / 20.0);
    }
    crate::preview_tools::discard(&store, &jobs, &job.id).unwrap();
    spec["frameOnly"] = json!(true);
    for time in [4.817, 5.183] {
        spec["start"] = json!(time);
        let job = crate::preview_tools::begin(&store, &rt, &jobs, &spec).unwrap();
        assert_eq!(wait(&jobs, &job.id).state, "completed");
        let result = crate::preview_tools::result(&store, &rt, &jobs, &job.id).unwrap();
        let decoded = decoded_video(&rt, Path::new(&result.native_path));
        assert_eq!(decoded.len(), 160 * 120 * 3);
        check(&decoded, time);
        crate::preview_tools::discard(&store, &jobs, &job.id).unwrap();
    }
}

#[test]
fn muted_transition_does_not_affect_export_and_invalid_anchors_are_rejected() {
    let temp = tempfile::tempdir().unwrap();
    let rt = runtime();
    let asset = sample(temp.path(), &rt);
    let store = MediaStore::new(temp.path()).unwrap();
    let mut spec = transition_spec(&asset, "fade");
    spec["project"]["tracks"][0]["muted"] = json!(true);
    run(temp.path(), &rt, spec.clone(), "muted-transition.mp4");
    let bytes = decoded_video(&rt, &temp.path().join("muted-transition.mp4"));
    let cut = &bytes[20 * 160 * 120 * 3..];
    assert!(cut[2] > 220 && cut[1] < 25, "muted transition must preserve the hard cut");
    for (field, value) in [("start", json!(0.5)), ("trimOut", json!(1.2)), ("speed", json!(2))] {
        let mut invalid = spec.clone();
        invalid["project"]["tracks"][0]["clips"][0][field] = value;
        assert!(build_plan(&store, &rt, &invalid).is_err(), "accepted invalid transition {field}");
    }
    for (field, value) in [("effect", json!("unknown")), ("toClipId", json!("missing")), ("fromClipId", json!("right"))] {
        let mut invalid = spec.clone();
        invalid["project"]["tracks"][0]["clips"][0]["transition"][field] = value;
        assert!(build_plan(&store, &rt, &invalid).is_err(), "accepted invalid binding {field}");
    }
    let mut gap = spec.clone();
    gap["project"]["tracks"][1]["clips"][1]["start"] = json!(1.1);
    assert!(build_plan(&store, &rt, &gap).is_err(), "accepted a transition across a gap");
    let mut duplicate = spec.clone();
    let existing = duplicate["project"]["tracks"][0]["clips"][0].clone();
    duplicate["project"]["tracks"][0]["clips"].as_array_mut().unwrap().push(existing);
    assert!(build_plan(&store, &rt, &duplicate).is_err(), "accepted two transitions at one cut");
    let mut overlapped = spec.clone();
    let covering = json!({"id":"covering","assetId":asset.id,"start":0,"trimIn":0,"trimOut":1.8,"speed":1});
    overlapped["project"]["tracks"][1]["clips"].as_array_mut().unwrap().push(covering);
    assert!(build_plan(&store, &rt, &overlapped).is_err(), "accepted a cut covered by another video clip");
}

#[test]
fn hidden_tracks_are_omitted_from_real_export_and_frame_preview() {
    let temp = tempfile::tempdir().unwrap();
    let rt = runtime();
    let asset = sample(temp.path(), &rt);
    let spec = json!({"kind":"timeline","project":{
        "width":160,"height":120,"fps":20,"background":"#00ff00","assets":[asset],
        "tracks":[
            {"kind":"text","hidden":true,"clips":[{"id":"unprepared-title","start":0,"trimIn":0,"trimOut":20,"speed":1}]},
            {"kind":"video","hidden":true,"clips":[{"id":"missing-overlay","assetId":"missing","start":0,"trimIn":0,"trimOut":10,"speed":1}]},
            {"kind":"audio","hidden":true,"clips":[{"id":"inaudible","assetId":asset.id,"start":0,"trimIn":0,"trimOut":2,"speed":1,"volume":1}]},
            {"kind":"transition","hidden":true,"clips":[{"id":"ignored-transition","transition":{"effect":"invalid","fromClipId":"missing","toClipId":"also-missing"}}]},
            {"kind":"video","clips":[{"id":"visible","assetId":asset.id,"start":0,"trimIn":0,"trimOut":0.8,"speed":1,"width":160,"height":120,"volume":0}]}
        ]
    },"config":{"format":"mp4","width":160,"height":120,"fps":20,"quality":"high"}});
    let (_, probe) = run(temp.path(), &rt, spec.clone(), "hidden-tracks.mp4");
    let duration: f64 = probe["format"]["duration"].as_str().unwrap().parse().unwrap();
    assert!((duration - 0.8).abs() < 0.01, "hidden-only tail changed export duration: {duration}");
    assert!(!probe["streams"].as_array().unwrap().iter().any(|stream| stream["codec_type"] == "audio"), "hidden audio was exported");
    let decoded = decoded_video(&rt, &temp.path().join("hidden-tracks.mp4"));
    assert_eq!(decoded.len(), 16 * 160 * 120 * 3);
    assert!(decoded.chunks_exact(3).all(|pixel| pixel[0] > 220 && pixel[1] < 25 && pixel[2] < 25), "hidden overlay changed visible frames");
    let store = MediaStore::new(temp.path()).unwrap();
    let jobs = JobManager::default();
    let preview = json!({"project":spec["project"],"frameOnly":true,"start":0.4,"width":160});
    let job = crate::preview_tools::begin(&store, &rt, &jobs, &preview).unwrap();
    assert_eq!(wait(&jobs, &job.id).state, "completed");
    let frame = crate::preview_tools::result(&store, &rt, &jobs, &job.id).unwrap();
    let pixels = decoded_video(&rt, Path::new(&frame.native_path));
    assert_eq!(pixels.len(), 160 * 120 * 3);
    assert!(pixels.chunks_exact(3).all(|pixel| pixel[0] > 220 && pixel[1] < 25 && pixel[2] < 25));
    crate::preview_tools::discard(&store, &jobs, &job.id).unwrap();
}

#[test]
fn hidden_transition_or_hidden_video_sources_do_not_change_visible_export() {
    let temp = tempfile::tempdir().unwrap();
    let rt = runtime();
    let asset = sample(temp.path(), &rt);
    let mut spec = transition_spec(&asset, "fade");
    spec["project"]["tracks"][0]["hidden"] = json!(true);
    run(temp.path(), &rt, spec.clone(), "hidden-transition.mp4");
    let pixels = decoded_video(&rt, &temp.path().join("hidden-transition.mp4"));
    let cut = &pixels[20 * 160 * 120 * 3..];
    assert!(cut[2] > 220 && cut[1] < 25, "hidden transition changed the hard cut");

    spec["project"]["tracks"][0]["hidden"] = json!(false);
    spec["project"]["tracks"][1]["hidden"] = json!(true);
    spec["project"]["tracks"].as_array_mut().unwrap().push(json!({"kind":"video","clips":[{
        "id":"visible","assetId":asset.id,"start":0,"trimIn":0,"trimOut":0.8,"speed":1,"width":160,"height":120,"volume":0
    }]}));
    let (_, probe) = run(temp.path(), &rt, spec, "hidden-transition-sources.mp4");
    let duration: f64 = probe["format"]["duration"].as_str().unwrap().parse().unwrap();
    assert!((duration - 0.8).abs() < 0.01, "transition on hidden sources extended export");
    let pixels = decoded_video(&rt, &temp.path().join("hidden-transition-sources.mp4"));
    assert!(pixels.chunks_exact(3).all(|pixel| pixel[0] > 220 && pixel[1] < 25 && pixel[2] < 25));
}

#[test]
fn transitions_keep_fractional_speed_adjusted_cuts_and_multiple_boundaries_in_sync() {
    let temp = tempfile::tempdir().unwrap();
    let rt = runtime();
    let asset = sample(temp.path(), &rt);
    let visual = |id: &str, start: f64, trim_in: f64, trim_out: f64| json!({
        "id":id,"assetId":asset.id,"start":start,"trimIn":trim_in,"trimOut":trim_out,
        "speed":1.25,"width":160,"height":120,"volume":0,"fadeIn":0,"fadeOut":0
    });
    let transition = |id: &str, cut: f64, from: &str, to: &str| json!({"id":id,"start":cut-0.15,"trimIn":0,"trimOut":0.3,"speed":1,"transition":{"effect":"fade","fromClipId":from,"toClipId":to}});
    let spec = json!({"kind":"timeline","project":{
        "width":160,"height":120,"fps":30,"background":"#00ff00","assets":[asset.clone()],
        "tracks":[
            {"kind":"transition","clips":[transition("first",0.537,"left","middle"),transition("second",1.073,"middle","right")]},
            {"kind":"video","muted":true,"clips":[visual("left",0.0,0.0,0.67125),visual("middle",0.537,0.67125,1.34125),visual("right",1.073,1.34125,2.0)]}
        ]
    },"config":{"format":"mp4","width":160,"height":120,"fps":30,"quality":"high"}});
    let (_, probe) = run(temp.path(), &rt, spec, "fractional-transitions.mp4");
    assert_eq!(probe["streams"][0]["nb_frames"], "48");
    let bytes = decoded_video(&rt, &temp.path().join("fractional-transitions.mp4"));
    for (frame_number, frame) in bytes.chunks_exact(160 * 120 * 3).enumerate() {
        let time = frame_number as f64 / 30.0;
        let pixel = &frame[(60 * 160 + 80) * 3..][..3];
        assert!(pixel.iter().any(|value| *value > 75), "black frame at {frame_number}: {pixel:?}");
        let nearest = (time - 0.537).abs().min((time - 1.073).abs());
        if nearest > 0.15 + 1.0 / 30.0 {
            assert!(pixel[1] < 25, "transition extends beyond its window at {frame_number}: {pixel:?}");
        }
        if nearest < 0.04 {
            assert!(pixel[1] > 180, "fractional transition does not align with its cut at {frame_number}: {pixel:?}");
        }
    }
}

#[test]
fn fragment_transitions_encode_live_textures_and_restore_both_endpoints() {
    let temp = tempfile::tempdir().unwrap();
    let rt = runtime();
    let source = temp.path().join("fragment-source.mp4");
    let created = process(&rt.encoder).args(["-v", "error", "-y", "-f", "lavfi", "-i",
        "nullsrc=s=160x120:r=20:d=2,geq=r='100+70*X/W+25*sin(8*T)':g='20+20*Y/H':b='80+70*Y/H+25*cos(8*T)'",
        "-c:v", "libx264", "-crf", "10", "-pix_fmt", "yuv420p"]).arg(&source).output().unwrap();
    assert!(
        created.status.success(),
        "{}",
        String::from_utf8_lossy(&created.stderr)
    );
    let reference = decoded_video(&rt, &source);
    let asset = MediaStore::new(temp.path())
        .unwrap()
        .import(&rt, &source, None)
        .unwrap();
    let frame_bytes = 160 * 120 * 3;
    let mut signatures = std::collections::HashSet::new();
    for effect in [
        "fragment-burst",
        "fragment-vortex",
        "fragment-collapse",
        "pixel-dissolve",
        "pixel-wave",
        "slice-stagger",
        "slice-vertical",
        "checker-flip",
        "tile-orbit",
        "glitch-slices",
        "zipper-slices",
        "stepped-shutter",
    ] {
        let filename = format!("{effect}.mp4");
        let started = Instant::now();
        let spec = transition_spec(&asset, effect);
        if let Some(folder) = std::env::var_os("OPEN_MEDIA_FRAGMENT_ARTIFACTS") {
            fs::create_dir_all(&folder).unwrap();
            let plan = build_plan(&MediaStore::new(temp.path()).unwrap(), &rt, &spec).unwrap();
            fs::copy(
                plan.workspace.path().join("filters.txt"),
                Path::new(&folder).join(format!("{effect}.ffgraph")),
            )
            .unwrap();
            fs::copy(&source, Path::new(&folder).join("texture-source.mp4")).unwrap();
        }
        let (_, probe) = run(temp.path(), &rt, spec, &filename);
        if let Some(folder) = std::env::var_os("OPEN_MEDIA_FRAGMENT_ARTIFACTS") {
            fs::copy(
                temp.path().join(&filename),
                Path::new(&folder).join(&filename),
            )
            .unwrap();
        }
        let decoded = decoded_video(&rt, &temp.path().join(&filename));
        assert_eq!(decoded.len(), frame_bytes * 40, "{effect}: dropped frames");
        assert_eq!(
            probe["streams"][0]["width"], 160,
            "{effect}: expanded canvas"
        );
        for frame in [2, 10, 29, 37] {
            let a = &decoded[frame * frame_bytes..(frame + 1) * frame_bytes];
            let b = &reference[frame * frame_bytes..(frame + 1) * frame_bytes];
            let mae = a
                .iter()
                .zip(b)
                .map(|(a, b)| (*a as f64 - *b as f64).abs())
                .sum::<f64>()
                / frame_bytes as f64;
            assert!(
                mae < 5.0,
                "{effect}: original texture not restored at frame {frame}, MAE={mae}"
            );
        }
        let cut = &decoded[20 * frame_bytes..21 * frame_bytes];
        assert!(
            cut.chunks_exact(3)
                .all(|p| p[1] > 235 && p[0] < 15 && p[2] < 15),
            "{effect}: nonempty exact cut"
        );
        for frame in [16, 24] {
            let image = &decoded[frame * frame_bytes..(frame + 1) * frame_bytes];
            let background = image
                .chunks_exact(3)
                .filter(|p| p[1] > 235 && p[0] < 15 && p[2] < 15)
                .count();
            let visible = image
                .chunks_exact(3)
                .filter(|p| p[0] > 20 && p[2] > 15)
                .count();
            assert!(
                background > if effect == "glitch-slices" { 90 } else { 300 } && visible > 40,
                "{effect}: missing fragments at frame {frame}, bg={background}, visible={visible}"
            );
            // A plain dissolve has a spatially smooth green channel; separated
            // image cells must instead expose full background and image texture.
            let greens: std::collections::HashSet<_> =
                image.chunks_exact(3).map(|p| p[1] / 8).collect();
            assert!(greens.len() > 4, "{effect}: no textured transparent edges");
        }
        let sample = &decoded[16 * frame_bytes..17 * frame_bytes];
        let signature: Vec<u8> = sample
            .chunks_exact(3)
            .step_by(17)
            .flat_map(|p| [p[0] / 16, p[1] / 16, p[2] / 16])
            .collect();
        assert!(
            signatures.insert(signature),
            "{effect}: duplicated transition output"
        );
        println!(
            "FRAGMENT_EXPORT {effect}: 40 decoded frames, endpoint MAE < 5, elapsed {:.3}s",
            started.elapsed().as_secs_f64()
        );
        if let Some(folder) = std::env::var_os("OPEN_MEDIA_FRAGMENT_ARTIFACTS") {
            fs::create_dir_all(&folder).unwrap();
            fs::copy(
                temp.path().join(&filename),
                Path::new(&folder).join(filename),
            )
            .unwrap();
        }
    }
}

#[test]
#[ignore = "explicit real 720p export performance observation"]
fn fragment_transition_real_720p_export_observation() {
    let temp = tempfile::tempdir().unwrap();
    let rt = runtime();
    let asset = sample(temp.path(), &rt);
    for effect in ["fragment-vortex", "pixel-wave"] {
        let mut spec = transition_spec(&asset, effect);
        for field in ["project", "config"] {
            spec[field]["width"] = json!(1280);
            spec[field]["height"] = json!(720);
        }
        for clip in spec["project"]["tracks"][1]["clips"]
            .as_array_mut()
            .unwrap()
        {
            clip["width"] = json!(1280);
            clip["height"] = json!(720);
        }
        let started = Instant::now();
        let (_, probe) = run(temp.path(), &rt, spec, "fragment-720p.mp4");
        let elapsed = started.elapsed().as_secs_f64();
        assert_eq!(probe["streams"][0]["width"], 1280);
        assert_eq!(probe["streams"][0]["height"], 720);
        let decoded = decoded_video(&rt, &temp.path().join("fragment-720p.mp4"));
        assert_eq!(decoded.len(), 40 * 1280 * 720 * 3);
        println!("FRAGMENT_720P {effect}: 2 seconds, 20 fps, 0.8 second window, actual encode {:.3}s, output decoded successfully", elapsed);
    }
}

#[test]
#[ignore = "explicit native/browser comparison using generated browser fixtures"]
fn fragment_transition_native_comparison_frames() {
    let folder = std::env::var_os("OPEN_MEDIA_FRAGMENT_ARTIFACTS")
        .expect("set OPEN_MEDIA_FRAGMENT_ARTIFACTS to browser fixture folder");
    let folder = Path::new(&folder);
    let rt = runtime();
    let store = MediaStore::new(&folder.join("native-store")).unwrap();
    let asset = store
        .import(&rt, &folder.join("source.webm"), None)
        .unwrap();
    let jobs = JobManager::default();
    let selected = std::env::var("OPEN_MEDIA_FRAGMENT_EFFECTS").ok();
    for size in ["320x180", "180x320"] {
        for effect in [
            "fragment-burst",
            "fragment-vortex",
            "fragment-collapse",
            "pixel-dissolve",
            "pixel-wave",
            "slice-stagger",
            "slice-vertical",
            "checker-flip",
            "tile-orbit",
            "glitch-slices",
            "zipper-slices",
            "stepped-shutter",
        ] {
            if selected
                .as_ref()
                .is_some_and(|list| !list.split(',').any(|item| item == effect))
            {
                continue;
            }
            let mut project: Value = serde_json::from_slice(
                &fs::read(folder.join(format!("native-{size}-{effect}.json"))).unwrap(),
            )
            .unwrap();
            project["assets"][0]["nativePath"] = json!(asset.native_path);
            for time in [1.5, 2.5] {
                let spec = json!({"project":project,"start":time,"end":time+0.1,"width":project["width"],"fps":30,"frameOnly":true});
                let job = crate::preview_tools::begin(&store, &rt, &jobs, &spec).unwrap();
                let finished = wait(&jobs, &job.id);
                assert_eq!(
                    finished.state, "completed",
                    "{size}/{effect}/{time}: {:?}",
                    finished.error
                );
                let result = crate::preview_tools::result(&store, &rt, &jobs, &job.id).unwrap();
                fs::copy(
                    &result.native_path,
                    folder.join(format!("native-{size}-{effect}-{time}.png")),
                )
                .unwrap();
                crate::preview_tools::discard(&store, &jobs, &job.id).unwrap();
            }
            println!("NATIVE_COMPARISON {size}/{effect} both sides rendered");
        }
    }
}

#[test]
#[ignore = "explicit late-cut buffering and tiny-frame regression"]
fn fragment_transition_late_cut_and_tiny_frame() {
    let temp = tempfile::tempdir().unwrap();
    let rt = runtime();
    let source = temp.path().join("long-source.mp4");
    let made = process(&rt.encoder)
        .args([
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=s=320x180:r=20:d=20",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-crf",
            "24",
            "-pix_fmt",
            "yuv420p",
        ])
        .arg(&source)
        .output()
        .unwrap();
    assert!(
        made.status.success(),
        "{}",
        String::from_utf8_lossy(&made.stderr)
    );
    let store = MediaStore::new(temp.path()).unwrap();
    let asset = store.import(&rt, &source, None).unwrap();
    let mut spec = transition_spec(&asset, "fragment-vortex");
    for field in ["project", "config"] {
        spec[field]["width"] = json!(320);
        spec[field]["height"] = json!(180);
    }
    spec["project"]["tracks"][0]["clips"][0]["start"] = json!(18.6);
    spec["project"]["tracks"][1]["clips"][0]["trimOut"] = json!(19);
    spec["project"]["tracks"][1]["clips"][1]["start"] = json!(19);
    spec["project"]["tracks"][1]["clips"][1]["trimIn"] = json!(19);
    spec["project"]["tracks"][1]["clips"][1]["trimOut"] = json!(20);
    for clip in spec["project"]["tracks"][1]["clips"]
        .as_array_mut()
        .unwrap()
    {
        clip["width"] = json!(320);
        clip["height"] = json!(180);
    }
    let jobs = JobManager::default();
    let started = Instant::now();
    let target = temp.path().join("late-cut.mp4");
    let job = jobs
        .begin(&rt, build_plan(&store, &rt, &spec).unwrap(), target.clone())
        .unwrap();
    let mut first_encoded = None;
    loop {
        let item = jobs
            .list()
            .into_iter()
            .find(|item| item.id == job.id)
            .unwrap();
        if first_encoded.is_none() && item.encoded_frames > 0 {
            first_encoded = Some(started.elapsed().as_secs_f64());
        }
        if item.state != "running" {
            assert_eq!(item.state, "completed", "{:?}", item.error);
            break;
        }
        if started.elapsed() > Duration::from_secs(60) {
            jobs.cancel(&job.id).unwrap();
            panic!("late transition timed out");
        }
        thread::sleep(Duration::from_millis(25));
    }
    let decoded = decoded_video(&rt, &target);
    assert_eq!(decoded.len(), 400 * 320 * 180 * 3);
    assert!(
        first_encoded.unwrap() < 5.0,
        "did not encode the prefix promptly: {first_encoded:?}"
    );
    println!(
        "FRAGMENT_LATE_CUT: 20s source, cut at19s, first encoded frame {:.3}s, complete {:.3}s",
        first_encoded.unwrap(),
        started.elapsed().as_secs_f64()
    );
    let mut project = transition_spec(&asset, "pixel-wave")["project"].clone();
    project["width"] = json!(16);
    project["height"] = json!(16000);
    for clip in project["tracks"][1]["clips"].as_array_mut().unwrap() {
        clip["width"] = json!(16);
        clip["height"] = json!(16000);
    }
    let tiny =
        json!({"project":project,"start":0.8,"end":0.9,"width":16,"fps":20,"frameOnly":true});
    let job = crate::preview_tools::begin(&store, &rt, &jobs, &tiny).unwrap();
    let done = wait(&jobs, &job.id);
    assert_eq!(done.state, "completed", "tiny frame: {:?}", done.error);
    let image = crate::preview_tools::result(&store, &rt, &jobs, &job.id).unwrap();
    assert_eq!(
        decoded_video(&rt, Path::new(&image.native_path)).len(),
        2 * 1920 * 3
    );
}
