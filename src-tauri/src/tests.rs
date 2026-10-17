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
