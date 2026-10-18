use super::*;

fn runtime() -> Runtime {
    Runtime::discover(None, None).unwrap()
}
fn await_job(jobs: &JobManager, id: &str, limit: f64) -> (MediaJob, f64) {
    let started = Instant::now();
    let mut first_progress = None;
    loop {
        let job = jobs.list().into_iter().find(|job| job.id == id).unwrap();
        if first_progress.is_none() && (job.encoded_frames > 0 || job.output_time > 0.0) {
            first_progress = Some(started.elapsed().as_secs_f64());
        }
        if job.state != "running" {
            assert_eq!(job.state, "completed", "{:?}", job.error);
            return (
                job,
                first_progress.unwrap_or(started.elapsed().as_secs_f64()),
            );
        }
        if started.elapsed().as_secs_f64() > limit {
            jobs.cancel(id).unwrap();
            panic!(
                "preview exceeded {limit}s, frames {}, output {}, stage {}",
                job.encoded_frames, job.output_time, job.stage
            );
        }
        thread::sleep(Duration::from_millis(25));
    }
}
fn rgba(runtime: &Runtime, path: &str) -> Vec<u8> {
    let output = engine::process(&runtime.encoder)
        .args([
            "-v",
            "error",
            "-i",
            path,
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
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    output.stdout
}
#[test]
fn native_frame_keeps_sixty_fps_source_identity_after_seek_and_speed_mapping() {
    let temp = tempfile::tempdir().unwrap();
    let store = MediaStore::new(temp.path()).unwrap();
    let runtime = runtime();
    let path = store.root.join("sixty.mkv");
    let status = engine::process(&runtime.encoder)
        .args([
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "nullsrc=s=160x90:r=60:d=20,format=gbrp,geq=r='mod(N,256)':g='floor(N/256)*40':b='0'",
            "-c:v",
            "ffv1",
            "-threads",
            "1",
            "-y",
        ])
        .arg(&path)
        .status()
        .unwrap();
    assert!(status.success());
    let asset = store.probe(&runtime, &path, "sixty.mkv").unwrap();
    let mut spec = json!({"frameOnly":true,"start":15.017,"width":1008,"project":{"width":160,"height":90,"fps":24,"background":"#000000","assets":[asset],"tracks":[{"kind":"video","clips":[{"id":"video","assetId":asset.id,"start":0,"trimIn":0,"trimOut":20,"speed":1,"width":160,"height":90,"x":0,"y":0,"volume":0,"opacity":1,"keyframes":{"scaleX":[{"time":0,"value":1},{"time":20,"value":2}],"scaleY":[{"time":0,"value":1},{"time":20,"value":2}]}}]}]}});
    // Future text inside the next output-frame interval is not active at this instant.
    // Frontend intentionally did not rasterize it, so native must not read it.
    spec["project"]["tracks"].as_array_mut().unwrap().insert(0,json!({"kind":"text","clips":[{"id":"future","start":15.02,"trimIn":0,"trimOut":0.1,"speed":1,"width":160,"height":90}]}));
    let jobs = JobManager::default();
    for (speed, time) in [(1.0, 15.017), (2.0, 7.5085)] {
        spec["start"] = json!(time);
        spec["project"]["tracks"][1]["clips"][0]["speed"] = json!(speed);
        let started = begin(&store, &runtime, &jobs, &spec).unwrap();
        let (job, _) = await_job(&jobs, &started.id, 30.0);
        let asset = result(&store, &runtime, &jobs, &started.id).unwrap();
        let bytes = rgba(&runtime, &asset.native_path);
        // Source frame 901 covers 15.016667..15.033333 s. A 30-fps resample
        // would instead return frame 900; both animation and media must be exact.
        let center = ((asset.height / 2 * asset.width + asset.width / 2) * 3) as usize;
        let pixel = &bytes[center..center + 3];
        assert_eq!(
            pixel,
            [133, 120, 0],
            "source frame at speed {speed}: {pixel:?}"
        );
        assert!(job.encoded_frames >= 1);
        discard(&store, &jobs, &started.id).unwrap();
    }
}

/// Run explicitly with --ignored --nocapture. The normal suite keeps focused
/// correctness tests fast; this fixture decodes real 4K media and reports timings.
#[test]
#[ignore = "real 4K focus/range performance benchmark"]
fn real_4k_twelve_focus_range_and_fifteen_second_frame_benchmark() {
    let temp = tempfile::tempdir().unwrap();
    let store = MediaStore::new(temp.path()).unwrap();
    let runtime = runtime();
    let path = store.root.join("4k.mp4");
    if let Ok(existing) = std::env::var("OPEN_MEDIA_BENCH_SOURCE") {
        fs::copy(existing, &path).unwrap();
    } else {
        let status = engine::process(&runtime.encoder)
            .args([
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=s=3840x2160:r=24:d=20",
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-crf",
                "28",
                "-threads",
                "2",
                "-y",
            ])
            .arg(&path)
            .status()
            .unwrap();
        assert!(status.success());
    }
    let asset = store.probe(&runtime, &path, "4k.mp4").unwrap();
    assert_eq!((asset.width, asset.height), (3840, 2160));
    assert!(asset.duration >= 20.0);
    let clips:Vec<Value>=(0..12).map(|i|json!({"id":format!("focus-{i}"),"assetId":asset.id,"start":i as f64*2.0,"trimIn":0,"trimOut":2,"speed":1,"volume":0,"opacity":1,"x":0,"y":0,"width":3840,"height":2160,"fit":"fill","keyframes":{"x":[{"time":0,"value":0},{"time":2,"value":if i%2==0{400}else{-400}}],"y":[{"time":0,"value":0},{"time":2,"value":100}],"scaleX":[{"time":0,"value":1},{"time":2,"value":3}],"scaleY":[{"time":0,"value":1},{"time":2,"value":3}]}})).collect();
    let mut spec = json!({"start":9,"end":19,"width":1008,"fps":24,"project":{"width":3840,"height":2160,"fps":24,"background":"#000000","assets":[asset],"tracks":[{"kind":"video","clips":clips}]}});
    let plan = make_plan(&store, &runtime, &spec).unwrap();
    let script = plan
        .args
        .iter()
        .position(|arg| arg == "-filter_complex_script")
        .unwrap();
    let graph = fs::read_to_string(&plan.args[script + 1]).unwrap();
    assert!(
        !graph.contains("geq="),
        "focus must not evaluate a giant per-pixel affine canvas"
    );
    assert_eq!(
        plan.args.iter().filter(|arg| *arg == "-i").count(),
        7,
        "only six intersecting clips and background"
    );
    assert!(
        !plan.args[script..].iter().any(|arg| arg == "-ss"),
        "range must not render from zero then discard output"
    );
    assert!(plan.args[..script].iter().any(|arg| arg == "-ss"));
    let jobs = JobManager::default();
    let started = Instant::now();
    let job = begin(&store, &runtime, &jobs, &spec).unwrap();
    let (done, first_progress) = await_job(&jobs, &job.id, 90.0);
    let video = result(&store, &runtime, &jobs, &job.id).unwrap();
    assert_eq!((video.width, video.height), (1008, 566));
    assert!((video.duration - 10.0).abs() < 0.1);
    assert_eq!(done.encoded_frames, 240);
    assert!(done.output_time > 9.0);
    eprintln!("BENCH production 4K 12-focus range9..19 output1008x566: {:.3}s, first-progress {:.3}s, encodedFrames {}, outputTime {}",started.elapsed().as_secs_f64(),first_progress,done.encoded_frames,done.output_time);
    discard(&store, &jobs, &job.id).unwrap();
    let mut full_project = spec["project"].clone();
    for (index, clip) in full_project["tracks"][0]["clips"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .enumerate()
    {
        clip["start"] = json!(index);
        clip["trimOut"] = json!(1);
        for name in ["x", "y", "scaleX", "scaleY"] {
            clip["keyframes"][name][1]["time"] = json!(1);
        }
    }
    let plan=engine::build_plan(&store,&runtime,&json!({"kind":"timeline","project":full_project,"textAssets":{},"config":{"format":"mp4","width":1008,"height":566,"fps":12,"quality":"draft"}})).unwrap();
    let started = Instant::now();
    let job = jobs
        .begin(&runtime, plan, store.root.join("full-focus.mp4"))
        .unwrap();
    let (done, first_progress) = await_job(&jobs, &job.id, 90.0);
    assert_eq!(done.encoded_frames, 144);
    assert!(done.output_time > 11.0);
    eprintln!("BENCH full export 4K 12-focus 12s/12fps output1008x566: {:.3}s, first-progress {:.3}s, encodedFrames {}, outputTime {}",started.elapsed().as_secs_f64(),first_progress,done.encoded_frames,done.output_time);
    let exported = store
        .probe(
            &runtime,
            &PathBuf::from(done.output_path.unwrap()),
            "full-focus.mp4",
        )
        .unwrap();
    assert!((exported.duration - 12.0).abs() < 0.1);
    // Keep one long source clip to ensure a frame at 15 seconds does not decode
    // or run animation over the preceding 15 seconds.
    let mut single = spec["project"]["tracks"][0]["clips"][0].clone();
    single["trimOut"] = json!(20);
    single["keyframes"]["x"][1]["time"] = json!(20);
    single["keyframes"]["y"][1]["time"] = json!(20);
    single["keyframes"]["scaleX"][1]["time"] = json!(20);
    single["keyframes"]["scaleY"][1]["time"] = json!(20);
    spec["project"]["tracks"][0]["clips"] = json!([single]);
    spec["frameOnly"] = json!(true);
    spec["start"] = json!(15.017);
    let started = Instant::now();
    let job = begin(&store, &runtime, &jobs, &spec).unwrap();
    let (done, first_progress) = await_job(&jobs, &job.id, 30.0);
    let png = result_payload(&store, &runtime, &jobs, &job.id).unwrap();
    assert_eq!(
        (png["width"].as_u64(), png["height"].as_u64()),
        (Some(1008), Some(567))
    );
    assert!(png["pngBase64"].as_str().unwrap().len() > 1000);
    eprintln!("BENCH production 4K frame15.017 output1008x567: {:.3}s, first-progress {:.3}s, encodedFrames {}",started.elapsed().as_secs_f64(),first_progress,done.encoded_frames);
    discard(&store, &jobs, &job.id).unwrap();
}

#[test]
fn range_seek_preserves_focus_pivot_and_audio_ramp_gain_against_full_render() {
    let temp = tempfile::tempdir().unwrap();
    let store = MediaStore::new(temp.path()).unwrap();
    let runtime = runtime();
    let path = store.root.join("split.mp4");
    let status = engine::process(&runtime.encoder)
        .args([
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=red:s=192x128:r=24:d=4,drawbox=x=96:y=0:w=96:h=128:color=blue:t=fill",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000:duration=4",
            "-c:v",
            "libx264",
            "-c:a",
            "aac",
            "-threads",
            "1",
            "-y",
        ])
        .arg(&path)
        .status()
        .unwrap();
    assert!(status.success());
    let asset = store.probe(&runtime, &path, "split.mp4").unwrap();
    let mut spec = json!({"start":0,"end":4,"width":192,"fps":24,"project":{"width":192,"height":128,"fps":24,"background":"#000000","assets":[asset],"tracks":[{"kind":"video","clips":[{"id":"video","assetId":asset.id,"start":0,"trimIn":0,"trimOut":4,"speed":1,"width":192,"height":128,"x":0,"y":0,"volume":1,"opacity":1,"keyframes":{"x":[{"time":0,"value":0},{"time":4,"value":40}],"scaleX":[{"time":0,"value":1},{"time":4,"value":2}],"scaleY":[{"time":0,"value":1},{"time":4,"value":2}],"volume":[{"time":0,"value":0.2},{"time":4,"value":1}]}}]}]}});
    let jobs = JobManager::default();
    let job = begin(&store, &runtime, &jobs, &spec).unwrap();
    await_job(&jobs, &job.id, 30.0);
    let full = result(&store, &runtime, &jobs, &job.id).unwrap();
    spec["start"] = json!(1);
    spec["end"] = json!(3);
    let job = begin(&store, &runtime, &jobs, &spec).unwrap();
    await_job(&jobs, &job.id, 30.0);
    let range = result(&store, &runtime, &jobs, &job.id).unwrap();
    let frame = |asset: &Asset, time: &str| {
        let out = engine::process(&runtime.encoder)
            .args([
                "-v",
                "error",
                "-ss",
                time,
                "-i",
                &asset.native_path,
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
        assert!(out.status.success());
        out.stdout
    };
    let full_pixels = frame(&full, "1.5");
    let range_pixels = frame(&range, "0.5");
    assert_eq!(full_pixels.len(), range_pixels.len());
    let difference = full_pixels
        .iter()
        .zip(&range_pixels)
        .map(|(a, b)| (*a as f64 - *b as f64).abs())
        .sum::<f64>()
        / full_pixels.len() as f64;
    assert!(difference < 2.0, "range/full focus difference {difference}");
    for (x, channel) in [(104, 0), (118, 2)] {
        let pixel = &range_pixels[(64 * 192 + x) * 3..(64 * 192 + x) * 3 + 3];
        assert!(
            pixel[channel] > 210,
            "zoom pivot at source center + x15: {pixel:?}"
        );
    }
    let clip = &mut spec["project"]["tracks"][0]["clips"][0];
    clip["speedRamp"] =
        json!({"points":[{"position":0,"speed":1},{"position":1,"speed":2}],"easing":"linear"});
    clip["fadeIn"] = json!(0.5);
    clip["fadeOut"] = json!(0.5);
    let length = crate::clip_animation::duration(clip).unwrap();
    spec["audioOnly"] = json!(true);
    spec["start"] = json!(0);
    spec["end"] = json!(length);
    let job = begin(&store, &runtime, &jobs, &spec).unwrap();
    await_job(&jobs, &job.id, 30.0);
    let full = result(&store, &runtime, &jobs, &job.id).unwrap();
    spec["start"] = json!(0.75);
    spec["end"] = json!(1.75);
    let job = begin(&store, &runtime, &jobs, &spec).unwrap();
    await_job(&jobs, &job.id, 30.0);
    let range = result(&store, &runtime, &jobs, &job.id).unwrap();
    let pcm = |asset: &Asset| {
        let out = engine::process(&runtime.encoder)
            .args([
                "-v",
                "error",
                "-i",
                &asset.native_path,
                "-ac",
                "1",
                "-ar",
                "48000",
                "-f",
                "f32le",
                "-",
            ])
            .output()
            .unwrap();
        assert!(out.status.success());
        out.stdout
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
            .collect::<Vec<_>>()
    };
    let full = pcm(&full);
    let range = pcm(&range);
    assert!((range.len() as i64 - 48000).abs() < 4);
    let rms = |samples: &[f32]| {
        (samples.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / samples.len() as f64).sqrt()
    };
    for offset in [2400, 14400, 26400, 38400] {
        let expected = rms(&full[36000 + offset..36000 + offset + 2400]);
        let actual = rms(&range[offset..offset + 2400]);
        assert!(
            (expected - actual).abs() < 0.002,
            "ramp/gain source clock at {offset}: full {expected}, range {actual}"
        );
    }
}

#[test]
fn high_speed_range_does_not_double_trim_unavailable_tempo_preroll() {
    let temp = tempfile::tempdir().unwrap();
    let store = MediaStore::new(temp.path()).unwrap();
    let runtime = runtime();
    let path = store.root.join("long.wav");
    let status = engine::process(&runtime.encoder)
        .args([
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "aevalsrc=0.15*sin(2*PI*440*t)*(0.2+0.8*t/120):s=48000:d=120",
            "-c:a",
            "pcm_s16le",
            "-y",
        ])
        .arg(&path)
        .status()
        .unwrap();
    assert!(status.success());
    let asset = store.probe(&runtime, &path, "long.wav").unwrap();
    let clip = json!({"id":"audio","assetId":asset.id,"start":0,"trimIn":0,"trimOut":120,"speed":1,"volume":1,"speedRamp":{"points":[{"position":0,"speed":4},{"position":1,"speed":5}],"easing":"linear"}});
    let duration = crate::clip_animation::duration(&clip).unwrap();
    let mut spec = json!({"audioOnly":true,"start":0,"end":duration,"width":16,"fps":10,"project":{"width":16,"height":16,"fps":10,"assets":[asset],"tracks":[{"kind":"audio","clips":[clip]}]}});
    let jobs = JobManager::default();
    let pcm = |asset: &Asset| {
        let out = engine::process(&runtime.encoder)
            .args([
                "-v",
                "error",
                "-i",
                &asset.native_path,
                "-ac",
                "1",
                "-ar",
                "48000",
                "-f",
                "f32le",
                "-",
            ])
            .output()
            .unwrap();
        assert!(out.status.success());
        out.stdout
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
            .collect::<Vec<_>>()
    };
    let job = begin(&store, &runtime, &jobs, &spec).unwrap();
    await_job(&jobs, &job.id, 30.0);
    let full = pcm(&result(&store, &runtime, &jobs, &job.id).unwrap());
    spec["start"] = json!(4);
    spec["end"] = json!(5);
    let job = begin(&store, &runtime, &jobs, &spec).unwrap();
    await_job(&jobs, &job.id, 30.0);
    let range = pcm(&result(&store, &runtime, &jobs, &job.id).unwrap());
    let rms = |samples: &[f32]| {
        (samples.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / samples.len() as f64).sqrt()
    };
    assert_eq!(range.len(), 48000);
    for offset in (0..45600).step_by(2400) {
        let expected = rms(&full[192000 + offset..192000 + offset + 2400]);
        let actual = rms(&range[offset..offset + 2400]);
        assert!(
            actual > 0.02 && (expected - actual).abs() < 0.002,
            "range first ramp segment at {offset}: full {expected}, range {actual}"
        );
    }
}
