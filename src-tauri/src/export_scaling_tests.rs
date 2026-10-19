//! Real-media checks for split recordings and large timeline exports.
use crate::engine::{self, Asset, JobManager, MediaJob, MediaStore, RenderPlan, Runtime};
use serde_json::{json, Value};
use std::{
    fs,
    io::Read,
    path::Path,
    process::{Command, Output, Stdio},
    thread,
    time::{Duration, Instant},
};

// Drain both pipes while enforcing a deadline, including fixture generation and
// verification. A failed measurement must not leave a media process running.
fn bounded_output(mut command: Command, timeout: Duration) -> Output {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let out = thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).unwrap();
        bytes
    });
    let err = thread::spawn(move || {
        let mut bytes = Vec::new();
        stderr.read_to_end(&mut bytes).unwrap();
        bytes
    });
    let started = Instant::now();
    let (status, timed_out) = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break (status, false);
        }
        if started.elapsed() >= timeout {
            let _ = child.kill();
            break (child.wait().unwrap(), true);
        }
        thread::sleep(Duration::from_millis(10));
    };
    let output = Output {
        status,
        stdout: out.join().unwrap(),
        stderr: err.join().unwrap(),
    };
    assert!(
        !timed_out && output.status.success(),
        "media command timed_out={timed_out}, status={}: {}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
    output
}

fn runtime() -> Runtime {
    Runtime::discover(None, None).expect("real media runtime required")
}

struct ExportGuard(JobManager);
impl Drop for ExportGuard {
    fn drop(&mut self) {
        self.0.shutdown();
    }
}

fn export_plan(
    runtime: &Runtime,
    plan: RenderPlan,
    output: &Path,
    first_frame_budget: Duration,
    completion_budget: Duration,
) -> MediaJob {
    let jobs = ExportGuard(JobManager::default());
    let began = Instant::now();
    let pending = jobs.0.begin(runtime, plan, output.to_path_buf()).unwrap();
    let mut first_encoded_progress = None;
    loop {
        let current = jobs
            .0
            .list()
            .into_iter()
            .find(|job| job.id == pending.id)
            .unwrap();
        if current.encoded_frames > 0 && first_encoded_progress.is_none() {
            first_encoded_progress = Some(began.elapsed().as_secs_f64());
        }
        if current.state != "running" {
            eprintln!(
                "EXPORT_SCALING {}",
                json!({
                    "name":output.file_name().unwrap().to_string_lossy(),
                    "runtime":runtime.version,
                    "firstEncodedProgressSeconds":first_encoded_progress,
                    "elapsedSeconds":began.elapsed().as_secs_f64(),
                    "job":current,
                })
            );
            assert_eq!(current.state, "completed", "{:?}", current.error);
            assert!(
                first_encoded_progress.is_some(),
                "completed without encoded frames"
            );
            return current;
        }
        if began.elapsed() >= completion_budget
            || (first_encoded_progress.is_none() && began.elapsed() >= first_frame_budget)
        {
            jobs.0.cancel(&pending.id).unwrap();
            jobs.0.shutdown();
            assert!(
                jobs.0.list().iter().all(|job| job.state != "running"),
                "timed-out export did not release its worker"
            );
            panic!(
                "export exceeded measurement deadline after {:.3}s: {}",
                began.elapsed().as_secs_f64(),
                serde_json::to_string(&current).unwrap()
            );
        }
        thread::sleep(Duration::from_millis(10));
    }
}

fn export(runtime: &Runtime, store: &MediaStore, spec: &Value, output: &Path) -> MediaJob {
    export_plan(
        runtime,
        engine::build_plan(store, runtime, spec).unwrap(),
        output,
        Duration::from_secs(30),
        Duration::from_secs(60),
    )
}

fn recording(runtime: &Runtime, store: &MediaStore, duration: u32) -> Asset {
    let path = store.root.join(format!("recording-{duration}.mp4"));
    let mut command = engine::process(&runtime.encoder);
    command.args([
        "-v", "error", "-y", "-f", "lavfi", "-i",
        &format!("color=red:s=160x90:r=20:d={duration},drawbox=x=0:y=0:w=iw:h=ih:color=lime:t=fill:enable='gte(t,10)*lt(t,20)',drawbox=x=0:y=0:w=iw:h=ih:color=blue:t=fill:enable='gte(t,20)'"),
        "-f", "lavfi", "-i",
        &format!("aevalsrc='0.1*sin(2*PI*if(lt(t,10),440,if(lt(t,20),880,1320))*t)':s=48000:d={duration}"),
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-g", "200",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-threads", "2",
    ]).arg(&path);
    bounded_output(command, Duration::from_secs(60));
    store.probe(runtime, &path, "recording.mp4").unwrap()
}

fn text_asset(store: &MediaStore, name: &str, width: u32, height: u32) -> Asset {
    let path = store.root.join(name);
    let mut pixels = vec![0_u8; (width * height * 4) as usize];
    // Opaque strokes surrounded by transparency exercise the same raster image
    // and alpha-compositing path as prepared text assets.
    for y in height / 4..height * 3 / 4 {
        for x in width / 4..width * 3 / 4 {
            let offset = ((y * width + x) * 4) as usize;
            pixels[offset..offset + 4].copy_from_slice(&[255; 4]);
        }
    }
    let mut encoder = png::Encoder::new(fs::File::create(&path).unwrap(), width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder
        .write_header()
        .unwrap()
        .write_image_data(&pixels)
        .unwrap();
    store.import_png(&path, name).unwrap()
}

fn pixels_at(runtime: &Runtime, path: &Path, x: u32, y: u32) -> Vec<[u8; 3]> {
    let mut command = engine::process(&runtime.encoder);
    command.args(["-v", "error", "-i"]).arg(path).args([
        "-an",
        "-vf",
        &format!("format=rgb24,crop=1:1:{x}:{y}:exact=1"),
        "-fps_mode",
        "passthrough",
        "-threads",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-",
    ]);
    bounded_output(command, Duration::from_secs(60))
        .stdout
        .chunks_exact(3)
        .map(|pixel| pixel.try_into().unwrap())
        .collect()
}

fn decoded_audio(runtime: &Runtime, path: &Path) -> Vec<f32> {
    let mut command = engine::process(&runtime.encoder);
    command
        .args(["-v", "error", "-i"])
        .arg(path)
        .args(["-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"]);
    bounded_output(command, Duration::from_secs(60))
        .stdout
        .chunks_exact(4)
        .map(|bytes| f32::from_le_bytes(bytes.try_into().unwrap()))
        .collect()
}

fn audio_window(samples: &[f32], time: f64) -> &[f32] {
    &samples[(time * 16000.0).round() as usize..((time + 0.1) * 16000.0).round() as usize]
}

fn rms(samples: &[f32]) -> f64 {
    (samples
        .iter()
        .map(|sample| f64::from(*sample).powi(2))
        .sum::<f64>()
        / samples.len() as f64)
        .sqrt()
}

#[test]
fn late_split_recording_preserves_video_audio_speed_and_gaps() {
    let root = tempfile::tempdir().unwrap();
    let store = MediaStore::new(root.path()).unwrap();
    let runtime = runtime();
    let asset = recording(&runtime, &store, 30);
    let clip = |id, start, trim_in, trim_out, speed| {
        json!({
            "id":id,"assetId":asset.id,"start":start,"trimIn":trim_in,"trimOut":trim_out,
            "speed":speed,"width":160,"height":90,"x":0,"y":0,"opacity":1,"volume":1,
        })
    };
    let spec = json!({"kind":"timeline","project":{
        "width":160,"height":90,"fps":20,"background":"#000000","assets":[asset],
        "tracks":[{"kind":"video","clips":[
            clip("late",0.25,24.125,25.375,1.0),
            clip("middle-fast",2.0,14.375,16.375,2.0),
            clip("early",3.5,4.25,5.5,1.0),
        ]}]},"config":{"width":160,"height":90,"fps":20,"format":"mp4","quality":"high"}});
    let output = root.path().join("late-splits.mp4");
    let job = export(&runtime, &store, &spec, &output);
    assert_eq!(job.encoded_frames, 95);
    let pixels = pixels_at(&runtime, &output, 80, 44);
    assert_eq!(pixels.len(), 95);
    for (frame, pixel) in pixels.iter().enumerate() {
        let channel = match frame {
            5..=29 => Some(2),
            40..=59 => Some(1),
            70..=94 => Some(0),
            _ => None,
        };
        if let Some(channel) = channel {
            assert!(
                pixel[channel] > 200,
                "wrong source frame {frame}: {pixel:?}"
            );
            assert!(
                pixel
                    .iter()
                    .enumerate()
                    .all(|(i, value)| i == channel || *value < 35),
                "wrong source color {frame}: {pixel:?}"
            );
        } else {
            assert!(
                pixel.iter().all(|value| *value < 20),
                "video leaked into gap at {frame}: {pixel:?}"
            );
        }
    }
    let audio = decoded_audio(&runtime, &output);
    for time in [0.05, 1.65, 3.15] {
        assert!(
            rms(audio_window(&audio, time)) < 0.002,
            "audio leaked into gap at {time}"
        );
    }
    for (time, frequency) in [(0.6, 1320.0), (2.3, 880.0), (3.9, 440.0)] {
        let samples = audio_window(&audio, time);
        assert!(rms(samples) > 0.025, "missing audio at {time}");
        let measured = samples
            .windows(2)
            .filter(|pair| pair[0] <= 0.0 && pair[1] > 0.0)
            .count() as f64
            / 0.1;
        assert!(
            (measured - frequency).abs() <= 30.0,
            "audio source/pitch changed at {time}: {measured} vs {frequency}"
        );
    }
}

#[test]
fn static_text_with_nonzero_trim_preserves_exclusive_boundaries_and_gaps() {
    let root = tempfile::tempdir().unwrap();
    let store = MediaStore::new(root.path()).unwrap();
    let runtime = runtime();
    let text = text_asset(&store, "text.png", 32, 16);
    let mut assets = serde_json::Map::new();
    let clips: Vec<_> = [
        ("first", 0.5, 5.0),
        ("second", 1.5, 12.0),
        ("last", 3.0, 100.0),
    ]
    .into_iter()
    .map(|(id, start, trim)| {
        assets.insert(id.into(), json!(text));
        json!({"id":id,"start":start,"trimIn":trim,"trimOut":trim+0.5,"speed":1,
                "width":32,"height":16,"x":16,"y":16,"opacity":1})
    })
    .collect();
    // A transparent clip retains a one-second interval after the last caption.
    assets.insert("tail".into(), json!(text));
    let mut clips = clips;
    clips.push(
        json!({"id":"tail","start":0,"trimIn":0,"trimOut":4,"speed":1,
        "width":32,"height":16,"x":80,"y":60,"opacity":0}),
    );
    let spec = json!({"kind":"timeline","textAssets":assets,"project":{
        "width":160,"height":90,"fps":20,"background":"#0000ff","assets":[],
        "tracks":[{"kind":"text","clips":clips}]},
        "config":{"width":160,"height":90,"fps":20,"format":"mp4","quality":"high"}});
    let output = root.path().join("static-text.mp4");
    let job = export(&runtime, &store, &spec, &output);
    assert_eq!(job.encoded_frames, 80);
    let pixels = pixels_at(&runtime, &output, 32, 24);
    assert_eq!(pixels.len(), 80);
    for (frame, pixel) in pixels.iter().enumerate() {
        if matches!(frame, 10..=19 | 30..=39 | 60..=69) {
            assert!(
                pixel.iter().all(|value| *value > 220),
                "caption missing at {frame}: {pixel:?}"
            );
        } else {
            assert!(
                pixel[2] > 200 && pixel[0] < 35 && pixel[1] < 35,
                "caption leaked across boundary at {frame}: {pixel:?}"
            );
        }
    }
    for pixel in pixels_at(&runtime, &output, 17, 17) {
        assert!(
            pixel[2] > 200 && pixel[0] < 35,
            "transparent text padding changed background: {pixel:?}"
        );
    }
}

#[test]
fn fractional_millisecond_mkv_slices_keep_every_source_frame() {
    let root = tempfile::tempdir().unwrap();
    let store = MediaStore::new(root.path()).unwrap();
    let runtime = runtime();
    let source = store.root.join("millisecond-clock.mkv");
    let mut command = engine::process(&runtime.encoder);
    command
        .args([
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "nullsrc=s=64x48:r=30:d=8,format=gbrp,geq=r='30+180*mod(N,2)':g='25*floor(N/30)':b='0'",
            "-c:v",
            "ffv1",
            "-threads",
            "1",
        ])
        .arg(&source);
    bounded_output(command, Duration::from_secs(30));
    let asset = store
        .probe(&runtime, &source, "millisecond-clock.mkv")
        .unwrap();
    for trim in [7.0 / 6.0, 37.0 / 6.0] {
        let spec = json!({"kind":"timeline","project":{
            "width":64,"height":48,"fps":30,"assets":[asset],"tracks":[{"kind":"video","clips":[{
                "id":"fractional","assetId":asset.id,"start":0,"trimIn":trim,"trimOut":trim+1.0,
                "speed":1,"width":64,"height":48,"volume":0,"opacity":1,
            }]}]},"config":{"width":64,"height":48,"fps":30,"format":"mp4","quality":"high"}});
        let output = root.path().join(format!("fractional-{trim}.mp4"));
        let job = export(&runtime, &store, &spec, &output);
        assert_eq!(job.encoded_frames, 30);
        let actual = pixels_at(&runtime, &output, 32, 24);
        // Independent reference deliberately decodes from the beginning, then
        // trims on the source's millisecond time base. Alternating frame colors
        // expose a single-frame shift caused by fractional input seeking.
        let mut command = engine::process(&runtime.encoder);
        command.args(["-v", "error", "-i"]).arg(&source).args([
            "-vf", &format!("trim=start={trim}:end={},setpts=PTS-STARTPTS,fps=30,format=rgb24,crop=1:1:32:24:exact=1", trim+1.0),
            "-frames:v", "30", "-threads", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
        ]);
        let reference = bounded_output(command, Duration::from_secs(30)).stdout;
        assert_eq!(actual.len(), 30);
        assert_eq!(reference.len(), 90);
        for (frame, (actual, expected)) in actual.iter().zip(reference.chunks_exact(3)).enumerate()
        {
            assert_eq!(
                actual[0] > 120,
                expected[0] > 120,
                "source-frame shift at trim={trim}, frame={frame}: {actual:?} vs {expected:?}"
            );
            assert!(
                (i16::from(actual[1]) - i16::from(expected[1])).abs() < 10,
                "wrong source second at trim={trim}, frame={frame}: {actual:?} vs {expected:?}"
            );
        }
    }
}

fn verify_streams(
    runtime: &Runtime,
    output: &Path,
    frames: u64,
    duration: f64,
    width: u32,
    height: u32,
) {
    let mut command = engine::process(&runtime.probe);
    command
        .args([
            "-v",
            "error",
            "-count_frames",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
        ])
        .arg(output);
    let result = bounded_output(command, Duration::from_secs(120));
    let probe: Value = serde_json::from_slice(&result.stdout).unwrap();
    let streams = probe["streams"].as_array().unwrap();
    let video = streams
        .iter()
        .find(|stream| stream["codec_type"] == "video")
        .unwrap();
    assert_eq!(
        video["nb_read_frames"]
            .as_str()
            .unwrap()
            .parse::<u64>()
            .unwrap(),
        frames
    );
    assert_eq!(
        (
            video["width"].as_u64().unwrap(),
            video["height"].as_u64().unwrap()
        ),
        (u64::from(width), u64::from(height))
    );
    assert!(streams.iter().any(|stream| stream["codec_type"] == "audio"));
    let measured = probe["format"]["duration"]
        .as_str()
        .unwrap()
        .parse::<f64>()
        .unwrap();
    assert!(
        (measured - duration).abs() < 0.15,
        "duration {measured}, expected {duration}"
    );
    let mut command = engine::process(&runtime.encoder);
    command
        .args(["-v", "error", "-xerror", "-i"])
        .arg(output)
        .args(["-f", "null", "-"]);
    bounded_output(command, Duration::from_secs(120));
    eprintln!(
        "EXPORT_SCALING_VERIFIED {}",
        json!({"frames":frames,"duration":measured,"width":width,"height":height})
    );
}

fn long_project(runtime: &Runtime, store: &MediaStore) -> Value {
    let recording = recording(runtime, store, 600);
    let music_path = store.root.join("music.m4a");
    let mut command = engine::process(&runtime.encoder);
    command
        .args([
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=220:sample_rate=48000:duration=600",
            "-c:a",
            "aac",
            "-b:a",
            "64k",
        ])
        .arg(&music_path);
    bounded_output(command, Duration::from_secs(60));
    let music = store.probe(runtime, &music_path, "music.m4a").unwrap();
    let speech_path = store.root.join("voice.m4a");
    let mut command = engine::process(&runtime.encoder);
    command
        .args([
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=660:sample_rate=48000:duration=5",
            "-c:a",
            "aac",
        ])
        .arg(&speech_path);
    bounded_output(command, Duration::from_secs(30));
    let speech = store.probe(runtime, &speech_path, "voice.m4a").unwrap();
    let video: Vec<_> = (0..30)
        .map(|index| {
            json!({
                "id":format!("video-{index}"),"assetId":recording.id,"start":index*20,
                "trimIn":index*20,"trimOut":(index+1)*20,"speed":1,
                "width":1920,"height":1080,"x":0,"y":0,"opacity":1,"volume":0.2,
            })
        })
        .collect();
    let mut text_assets = serde_json::Map::new();
    let text: Vec<_> = (0..50)
        .map(|index| {
            let id = format!("text-{index}");
            let asset = text_asset(store, &format!("caption-{index}.png"), 640, 96);
            text_assets.insert(id.clone(), json!(asset));
            json!({"id":id,"start":index*12,"trimIn":index,"trimOut":index+8,"speed":1,
            "width":640,"height":96,"x":640,"y":900,"opacity":1})
        })
        .collect();
    let voices: Vec<_> = [45, 245, 545]
        .into_iter()
        .enumerate()
        .map(|(index, start)| {
            json!({
                "id":format!("voice-{index}"),"assetId":speech.id,"start":start,
                "trimIn":0.25,"trimOut":4.25,"speed":1,"volume":0.5,
            })
        })
        .collect();
    let transitions: Vec<_> = [1, 15, 29].into_iter().map(|index| json!({
        "id":format!("transition-{index}"),"start":index as f64*20.0-0.5,
        "trimIn":0,"trimOut":1,"speed":1,"transition":{
            "effect":"wipe-left","fromClipId":format!("video-{}",index-1),"toClipId":format!("video-{index}")},
    })).collect();
    json!({"kind":"timeline","textAssets":text_assets,"project":{
        "width":1920,"height":1080,"fps":30,"background":"#000000",
        "assets":[recording,music,speech],"tracks":[
            {"kind":"text","clips":text}, {"kind":"transition","clips":transitions},
            {"kind":"video","clips":video}, {"kind":"audio","clips":voices},
            {"kind":"audio","clips":[{"id":"music","assetId":music.id,"start":0,
                "trimIn":0,"trimOut":600,"speed":1,"volume":0.1}]},
        ]},"config":{"width":160,"height":90,"fps":10,"format":"mp4","quality":"draft"}})
}

/// Measurements describe this generated fixture and runner, not performance of
/// arbitrary recordings or the user's machine. Run with --ignored --nocapture.
#[test]
#[ignore = "real ten-minute timeline with fifty text images and thirty source slices"]
fn ten_minute_split_recording_fifty_texts_and_1080p_startup() {
    let root = tempfile::tempdir().unwrap();
    let store = MediaStore::new(root.path()).unwrap();
    let runtime = runtime();
    let mut spec = long_project(&runtime, &store);
    let output = root.path().join("ten-minutes-small.mp4");
    let job = export_plan(
        &runtime,
        engine::build_plan(&store, &runtime, &spec).unwrap(),
        &output,
        Duration::from_secs(30),
        Duration::from_secs(300),
    );
    assert_eq!(job.encoded_frames, 6000);
    verify_streams(&runtime, &output, 6000, 600.0, 160, 90);

    spec["config"]["width"] = json!(1920);
    spec["config"]["height"] = json!(1080);
    spec["config"]["fps"] = json!(30);
    let mut plan = engine::build_plan(&store, &runtime, &spec).unwrap();
    // Keep all future clips in the actual ten-minute graph. A renderEnd preview
    // would remove precisely the deferred inputs whose startup is under test.
    plan.args
        .extend(["-t".into(), "3".into(), "-frames:v".into(), "90".into()]);
    plan.duration = 3.0;
    let output = root
        .path()
        .join("ten-minute-graph-first-three-seconds-1080p.mp4");
    let job = export_plan(
        &runtime,
        plan,
        &output,
        Duration::from_secs(45),
        Duration::from_secs(120),
    );
    assert_eq!(job.encoded_frames, 90);
    verify_streams(&runtime, &output, 90, 3.0, 1920, 1080);
}
