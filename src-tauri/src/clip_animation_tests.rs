use super::*;
use crate::engine::{build_plan, process, Asset, MediaStore, Runtime};
use serde_json::json;
use std::path::Path;

fn runtime() -> Runtime {
    Runtime::discover(None, None).unwrap()
}
fn source(root: &Path, rt: &Runtime, filter: &str) -> Asset {
    let path = root.join("input.mp4");
    let result = process(&rt.encoder)
        .args([
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            filter,
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000:duration=2",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-t",
            "2",
            "-threads",
            "1",
        ])
        .arg(&path)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    MediaStore::new(root)
        .unwrap()
        .import(rt, &path, None)
        .unwrap()
}
fn clip(asset: &Asset) -> Value {
    json!({"id":"visual","assetId":asset.id,"start":0,"trimIn":0,"trimOut":2,"speed":1,"volume":0,"opacity":1,"x":0,"y":0,"width":64,"height":48,"fit":"fill","rotation":0,"fadeIn":0,"fadeOut":0})
}
fn spec(asset: &Asset, clip: Value) -> Value {
    json!({"kind":"timeline","project":{"width":64,"height":48,"fps":20,"background":"#000000","assets":[asset],"tracks":[{"kind":"video","clips":[clip]}]},"config":{"format":"mp4","width":64,"height":48,"fps":20,"quality":"high"}})
}
fn render(root: &Path, rt: &Runtime, spec: &Value) -> (Vec<u8>, f64) {
    let plan = build_plan(&MediaStore::new(root).unwrap(), rt, spec).unwrap();
    let output = root.join("render.mp4");
    let result = process(&rt.encoder)
        .args(["-v", "error", "-y", "-filter_complex_threads", "1"])
        .args(&plan.args)
        .args(["-threads", "1"])
        .arg(&output)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&result.stderr),
        std::fs::read_to_string(plan.workspace.path().join("filters.txt")).unwrap_or_default()
    );
    let decoded = process(&rt.encoder)
        .args(["-v", "error", "-i"])
        .arg(output)
        .args(["-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
        .output()
        .unwrap();
    assert!(
        decoded.status.success(),
        "{}",
        String::from_utf8_lossy(&decoded.stderr)
    );
    (decoded.stdout, plan.duration)
}
fn pixel(bytes: &[u8], frame: usize, x: usize, y: usize) -> &[u8] {
    &bytes[(frame * 64 * 48 + y * 64 + x) * 3..][..3]
}
#[test]
fn native_keyframes_crop_freeze_and_blur_are_actual_frame_operations() {
    let temp = tempfile::tempdir().unwrap();
    let rt = runtime();
    let asset = source(
        temp.path(),
        &rt,
        "color=red:s=64x48:r=20:d=2,drawbox=x=32:y=0:w=32:h=48:color=blue:t=fill",
    );
    let mut cropped = clip(&asset);
    cropped["crop"] = json!({"x":0.5,"y":0,"width":0.5,"height":1});
    let (bytes, _) = render(temp.path(), &rt, &spec(&asset, cropped));
    assert!(
        pixel(&bytes, 10, 20, 20)[2] > 220,
        "source crop must expose blue half"
    );
    let mut animated = clip(&asset);
    animated["width"] = json!(20);
    animated["height"] = json!(10);
    animated["trimOut"] = json!(1);
    animated["keyframes"] = json!({"x":[{"time":0,"value":0},{"time":1,"value":40}],"scaleX":[{"time":0,"value":1},{"time":1,"value":2}],"rotation":[{"time":0,"value":0},{"time":1,"value":90}],"opacity":[{"time":0,"value":1},{"time":1,"value":0.3}]});
    let (bytes, _) = render(temp.path(), &rt, &spec(&asset, animated));
    let extent = |frame: usize| {
        let mut xs = Vec::new();
        for y in 0..48 {
            for x in 0..64 {
                let p = pixel(&bytes, frame, x, y);
                if p[0].max(p[2]) > 25 {
                    xs.push(x as f64);
                }
            }
        }
        assert!(!xs.is_empty());
        xs.iter().sum::<f64>() / xs.len() as f64
    };
    assert!(
        extent(16) > extent(0) + 25.0,
        "animated position did not move"
    );
    let mut frozen = clip(&asset);
    frozen["trimOut"] = json!(3);
    frozen["freezeFrame"] =
        json!({"sourceTime":1.2,"original":{"trimIn":0,"trimOut":2,"speed":1,"volume":0}});
    let (bytes, duration) = render(temp.path(), &rt, &spec(&asset, frozen));
    assert!((duration - 3.0).abs() < 1e-8);
    assert_eq!(bytes.len(), 60 * 64 * 48 * 3);
    assert_eq!(pixel(&bytes, 0, 40, 20), pixel(&bytes, 59, 40, 20));
    let mut blurred = spec(&asset, clip(&asset));
    blurred["project"]["tracks"].as_array_mut().unwrap().insert(0,json!({"kind":"text","clips":[{"id":"blur","start":0,"trimIn":0,"trimOut":2,"speed":1,"x":16,"y":0,"width":32,"height":48,"opacity":1,"overlay":{"kind":"blur","blurRadius":8}}]}));
    let (bytes, _) = render(temp.path(), &rt, &blurred);
    let mixed = pixel(&bytes, 10, 31, 20);
    assert!(
        mixed[0] > 40 && mixed[2] > 40,
        "local blur must mix source pixels: {mixed:?}"
    );
    assert!(
        pixel(&bytes, 10, 5, 20)[0] > 220,
        "blur must preserve pixels outside its bounds"
    );
}
#[test]
fn native_speed_ramp_preserves_partition_when_split_and_renders_duration() {
    let mut original = json!({"trimIn":0,"trimOut":2,"speed":1,"speedRamp":{"points":[{"position":0,"speed":1},{"position":1,"speed":4}],"easing":"ease-in-out","sourceRange":{"start":0,"end":2}}});
    let total = duration(&original).unwrap();
    let mut right = original.clone();
    original["trimOut"] = json!(0.73);
    right["trimIn"] = json!(0.73);
    assert!((duration(&original).unwrap() + duration(&right).unwrap() - total).abs() < 1e-10);
    let temp = tempfile::tempdir().unwrap();
    let rt = runtime();
    let asset = source(temp.path(), &rt, "color=red:s=64x48:r=20:d=2");
    let mut video = clip(&asset);
    video["volume"] = json!(1);
    video["speedRamp"] = right["speedRamp"].clone();
    let (bytes, actual) = render(temp.path(), &rt, &spec(&asset, video));
    assert!((actual - total).abs() < 1e-10);
    assert!((bytes.len() as f64 / (64.0 * 48.0 * 3.0 * 20.0) - total).abs() < 0.101);
}
#[test]
fn native_animation_rejects_invalid_values_and_eases_hold_before_first_keyframe() {
    let mut value = json!({"trimIn":0,"trimOut":3,"speed":1,"x":5,"keyframes":{"x":[{"time":1,"value":10,"easing":"step"},{"time":2,"value":50}]}});
    assert!(expression(&value, "x", 5.0, "t").unwrap().contains("gte("));
    value["keyframes"]["x"][1]["time"] = json!(0.5);
    assert!(expression(&value, "x", 5.0, "t").is_err());
    assert!(crop_filter(&json!({"crop":{"x":0.7,"y":0,"width":0.5,"height":1}})).is_err());
    assert!(visual_filter(
        &json!({"trimIn":0,"trimOut":1,"speed":1,"keyframes":{"scaleX":[{"time":0,"value":16}]}}),
        16000,
        16000,
        20.0
    )
    .is_err());
}
#[test]
fn native_transition_parameters_control_color_direction_easing_scope_and_blur() {
    let temp = tempfile::tempdir().unwrap();
    let rt = runtime();
    let asset = source(
        temp.path(),
        &rt,
        "color=red:s=64x48:r=20:d=2,drawbox=x=32:y=0:w=32:h=48:color=blue:t=fill",
    );
    let mut left = clip(&asset);
    left["id"] = json!("left");
    left["trimOut"] = json!(1);
    let mut right = clip(&asset);
    right["id"] = json!("right");
    right["start"] = json!(1);
    right["trimIn"] = json!(1);
    let mut base = spec(&asset, left);
    base["project"]["background"] = json!("#000000");
    base["project"]["tracks"][0]["clips"]
        .as_array_mut()
        .unwrap()
        .push(right);
    base["project"]["tracks"].as_array_mut().unwrap().insert(0,json!({"kind":"transition","clips":[{"id":"transition","start":0.5,"trimIn":0,"trimOut":1,"speed":1,"transition":{"effect":"fade","fromClipId":"left","toClipId":"right","color":"#00ff00"}}]}));
    let (bytes, _) = render(temp.path(), &rt, &base);
    let cut = pixel(&bytes, 20, 16, 24);
    assert!(
        cut[1] > 220 && cut[0] < 25,
        "color fade must show its configured color at cut: {cut:?}"
    );
    base["project"]["tracks"][0]["clips"][0]["transition"] = json!({"effect":"wipe-left","fromClipId":"left","toClipId":"right","direction":"up","easing":"ease-in","scope":"outgoing","blur":4});
    let (bytes, _) = render(temp.path(), &rt, &base);
    assert!(
        pixel(&bytes, 15, 16, 25)[0] < 25,
        "direction/easing must mask upper source"
    );
    assert!(
        pixel(&bytes, 15, 16, 43)[0] > 200,
        "direction/easing must retain bottom source"
    );
    assert!(
        pixel(&bytes, 20, 16, 24)[0] > 220,
        "outgoing scope must not mask the incoming clip"
    );
    base["project"]["tracks"][0]["clips"][0]["transition"] = json!({"effect":"slide-left","fromClipId":"left","toClipId":"right","direction":"down","scope":"incoming","blur":4});
    let (bytes, _) = render(temp.path(), &rt, &base);
    assert!(pixel(&bytes, 25, 16, 5)[0] < 25);
    assert!(pixel(&bytes, 25, 16, 43)[0] > 200);
}

#[test]
fn native_freeze_uses_the_requested_source_frame_and_holds_it() {
    let temp = tempfile::tempdir().unwrap();
    let rt = runtime();
    let asset = source(
        temp.path(),
        &rt,
        "color=red:s=64x48:r=20:d=2,drawbox=x=0:y=0:w=64:h=48:color=blue:t=fill:enable='gte(t,1)'",
    );
    let mut frozen = clip(&asset);
    frozen["trimOut"] = json!(2.5);
    frozen["freezeFrame"] =
        json!({"sourceTime":1.2,"original":{"trimIn":0,"trimOut":2,"speed":1,"volume":0}});
    let (bytes, duration) = render(temp.path(), &rt, &spec(&asset, frozen));
    assert_eq!(duration, 2.5);
    for frame in 0..50 {
        let center = pixel(&bytes, frame, 32, 24);
        assert!(
            center[2] > 220 && center[0] < 25,
            "freeze took wrong source frame at output {frame}: {center:?}"
        );
    }
}

fn audio_samples(rt: &Runtime, path: &Path) -> Vec<f32> {
    let result = process(&rt.encoder)
        .args(["-v", "error", "-i"])
        .arg(path)
        .args(["-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "-"])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    result
        .stdout
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
        .collect()
}
#[test]
fn native_ramp_audio_preserves_or_changes_pitch_and_has_no_silent_bins() {
    let temp = tempfile::tempdir().unwrap();
    let rt = runtime();
    let asset = source(temp.path(), &rt, "color=red:s=64x48:r=20:d=2");
    for preserve in [true, false] {
        let mut audio = clip(&asset);
        audio["volume"] = json!(1);
        audio["speedRamp"] = json!({"points":[{"position":0,"speed":2},{"position":1,"speed":2}],"preservePitch":preserve});
        render(temp.path(), &rt, &spec(&asset, audio));
        let samples = audio_samples(&rt, &temp.path().join("render.mp4"));
        let interior = &samples[2400..43200];
        let crossings = interior
            .windows(2)
            .filter(|pair| pair[0] <= 0.0 && pair[1] > 0.0)
            .count();
        let frequency = crossings as f64 / (interior.len() as f64 / 48000.0);
        let expected = if preserve { 440.0 } else { 880.0 };
        assert!(
            (frequency - expected).abs() < 25.0,
            "pitch mismatch preserve={preserve}: {frequency}"
        );
        for (i, window) in interior.chunks(480).enumerate() {
            let rms = (window.iter().map(|v| (*v as f64).powi(2)).sum::<f64>()
                / window.len() as f64)
                .sqrt();
            assert!(
                rms > 0.02,
                "silent curve bin {i}, preserve={preserve}, rms={rms}"
            );
        }
        let largest_step = interior
            .windows(2)
            .map(|pair| (pair[1] - pair[0]).abs())
            .fold(0.0_f32, f32::max);
        assert!(
            largest_step < 0.08,
            "audible discontinuity at curve bin, preserve={preserve}: {largest_step}"
        );
    }
    for preserve in [true, false] {
        let mut curved = clip(&asset);
        curved["volume"] = json!(1);
        curved["speedRamp"] = json!({"points":[{"position":0,"speed":1},{"position":0.43,"speed":3},{"position":1,"speed":1.5}],"preservePitch":preserve,"easing":"ease-in-out"});
        let (_, duration) = render(temp.path(), &rt, &spec(&asset, curved));
        let samples = audio_samples(&rt, &temp.path().join("render.mp4"));
        let interior = &samples[2400..((duration * 48000.0) as usize - 2400)];
        let largest_step = interior
            .windows(2)
            .map(|pair| (pair[1] - pair[0]).abs())
            .fold(0.0_f32, f32::max);
        assert!(
            largest_step < 0.08,
            "variable curve click preserve={preserve}: {largest_step}"
        );
        assert!(
            interior.chunks(480).all(|window| (window
                .iter()
                .map(|v| (*v as f64).powi(2))
                .sum::<f64>()
                / window.len() as f64)
                .sqrt()
                > 0.015),
            "variable curve contains a silent bin"
        );
    }
    let mut volume = clip(&asset);
    volume["volume"] = json!(0);
    volume["trimOut"] = json!(1);
    volume["keyframes"] = json!({"volume":[{"time":0,"value":0},{"time":1,"value":1}]});
    render(temp.path(), &rt, &spec(&asset, volume));
    let samples = audio_samples(&rt, &temp.path().join("render.mp4"));
    let rms = |a: usize, b: usize| {
        (samples[a..b]
            .iter()
            .map(|v| (*v as f64).powi(2))
            .sum::<f64>()
            / (b - a) as f64)
            .sqrt()
    };
    assert!(
        rms(33600, 38400) > rms(7200, 12000) * 2.0,
        "volume animation not applied"
    );
}

#[test]
fn native_audio_only_preview_keeps_text_duration_without_raster_assets() {
    let temp = tempfile::tempdir().unwrap();
    let rt = runtime();
    let project = json!({"kind":"timeline","audioOnly":true,"project":{"width":64,"height":48,"assets":[],"tracks":[{"kind":"text","clips":[{"id":"caption","start":0.25,"trimIn":0,"trimOut":0.75,"speed":1,"text":"没有PNG的字幕"}]}]},"config":{"format":"mp4","width":64,"height":48,"fps":20}});
    let (_, duration) = render(temp.path(), &rt, &project);
    assert_eq!(duration, 1.0);
    let samples = audio_samples(&rt, &temp.path().join("render.mp4"));
    assert!(samples.len() >= 47000);
    assert!(samples.iter().all(|v| v.abs() < 0.00001));
}

#[test]
fn native_split_preserves_keyframe_clock_at_fractional_clip_offsets() {
    let temp = tempfile::tempdir().unwrap();
    let rt = runtime();
    let asset = source(temp.path(), &rt, "color=red:s=64x48:r=20:d=2");
    let mut animated = clip(&asset);
    animated["start"] = json!(0.037);
    animated["width"] = json!(20);
    animated["height"] = json!(12);
    animated["keyframes"] = json!({"x":[{"time":0,"value":0,"easing":"ease-in"},{"time":2,"value":40}],"rotation":[{"time":0,"value":0},{"time":2,"value":70}],"opacity":[{"time":0,"value":1},{"time":2,"value":0.3}]});
    let (whole, _) = render(temp.path(), &rt, &spec(&asset, animated.clone()));
    let mut second = animated.clone();
    second["id"] = json!("right");
    second["start"] = json!(0.767);
    second["trimIn"] = json!(0.73);
    second["animationOffset"] = json!(0.73);
    animated["trimOut"] = json!(0.73);
    let mut split = spec(&asset, animated);
    split["project"]["tracks"][0]["clips"]
        .as_array_mut()
        .unwrap()
        .push(second);
    let (divided, _) = render(temp.path(), &rt, &split);
    assert_eq!(whole.len(), divided.len());
    let error = whole
        .iter()
        .zip(&divided)
        .map(|(a, b)| (*a as f64 - *b as f64).abs())
        .sum::<f64>()
        / whole.len() as f64;
    assert!(
        error < 2.5,
        "split changed animation timing: mean difference {error}"
    );
}
