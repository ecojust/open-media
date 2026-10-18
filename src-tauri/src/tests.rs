use crate::{capture::parse_devices, engine::*};
use serde_json::{json, Value};
use std::{
    fs,
    path::Path,
    thread,
    time::{Duration, Instant},
};
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
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let item = jobs.list().into_iter().find(|j| j.id == id).unwrap();
        if item.state != "running" {
            return item;
        }
        assert!(Instant::now() < deadline, "job timeout");
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
    let spec = json!({"kind":"timeline","project":{"title":"project","width":160,"height":120,"background":"#003300","assets":[asset.clone()],"tracks":[{"kind":"text","muted":false,"clips":[text]},{"kind":"video","muted":false,"clips":[clip(&asset)]}]},"config":{"format":"mp4","width":160,"height":120,"fps":20,"quality":"balanced"},"textAssets":{"title":caption}});
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
