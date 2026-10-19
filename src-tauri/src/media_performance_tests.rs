//! Explicit performance observations run separately from concurrent regression jobs.
use super::*;

fn encode_plan(runtime: &Runtime, plan: &RenderPlan, path: &Path) {
    let output = process(&runtime.encoder)
        .args([
            "-v",
            "error",
            "-nostdin",
            "-y",
            "-threads",
            "2",
            "-filter_complex_threads",
            "1",
        ])
        .args(&plan.args)
        .args(["-f", &plan.format])
        .arg(path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn decoded(runtime: &Runtime, path: &Path, audio: bool) -> Vec<u8> {
    let mut command = process(&runtime.encoder);
    command.args(["-v", "error", "-i"]).arg(path);
    if audio {
        command.args(["-vn", "-c:a", "pcm_s16le", "-f", "s16le", "-"]);
    } else {
        command.args([
            "-an",
            "-fps_mode",
            "passthrough",
            "-pix_fmt",
            "rgb24",
            "-f",
            "rawvideo",
            "-",
        ]);
    }
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!output.stdout.is_empty());
    output.stdout
}

#[test]
fn seeking_keeps_variable_frames_audio_offsets_and_gif_segment_order() {
    let temp = tempfile::tempdir().unwrap();
    let rt = runtime();
    let store = MediaStore::new(temp.path()).unwrap();
    for timestamp_offset in [0, 7] {
        let source = temp
            .path()
            .join(format!("irregular-{timestamp_offset}.mkv"));
        let made = process(&rt.encoder)
            .args([
                "-v",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=s=64x48:r=20:d=6",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=48000:duration=6",
            ])
            .args([
                "-vf",
                &format!("select='not(eq(mod(n,4),1))',setpts=PTS+{timestamp_offset}/TB"),
                "-af",
                &format!("asetpts=PTS+({timestamp_offset}+0.125)/TB"),
            ])
            .args([
                "-fps_mode",
                "vfr",
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-g",
                "120",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "pcm_s16le",
                "-threads",
                "2",
            ])
            .arg(&source)
            .output()
            .unwrap();
        assert!(
            made.status.success(),
            "{}",
            String::from_utf8_lossy(&made.stderr)
        );
        let asset = store.import(&rt, &source, None).unwrap();
        for format in ["mp4", "wav", "png"] {
            let spec = json!({"kind":"convert","asset":asset,"format":format,"width":64,"height":48,"fps":10,"trimStart":1.175,"trimEnd":2.675});
            let plan = build_plan(&store, &rt, &spec).unwrap();
            let mut reference = build_plan(&store, &rt, &spec).unwrap();
            let seek = reference.args.iter().position(|arg| arg == "-ss").unwrap();
            let seek_args: Vec<_> = reference.args.drain(seek..seek + 2).collect();
            let input = reference.args.iter().position(|arg| arg == "-i").unwrap();
            reference.args.splice(input + 2..input + 2, seek_args);
            let output = temp
                .path()
                .join(format!("seek-{timestamp_offset}.{format}"));
            let original = temp
                .path()
                .join(format!("reference-{timestamp_offset}.{format}"));
            encode_plan(&rt, &plan, &output);
            encode_plan(&rt, &reference, &original);
            if format != "wav" {
                assert!(
                    decoded(&rt, &output, false) == decoded(&rt, &original, false),
                    "Video frame mismatch: format={format}, offset={timestamp_offset}"
                );
            }
            if format != "png" {
                assert!(
                    decoded(&rt, &output, true) == decoded(&rt, &original, true),
                    "Audio timing mismatch: format={format}, offset={timestamp_offset}"
                );
            }
        }
        let spec = json!({"kind":"gif","asset":asset,"segments":[{"start":3.125,"end":3.825},{"start":1.175,"end":1.875},{"start":3.125,"end":3.825}],"width":64,"fps":10,"loop":false});
        let plan = build_plan(&store, &rt, &spec).unwrap();
        let mut reference = build_plan(&store, &rt, &spec).unwrap();
        reference.args = vec!["-i".into(), asset.native_path.clone(), "-filter_complex".into(), "[0:v]trim=start=3.125:end=3.825,setpts=PTS-STARTPTS,scale=64:-2,fps=10[s0];[0:v]trim=start=1.175:end=1.875,setpts=PTS-STARTPTS,scale=64:-2,fps=10[s1];[0:v]trim=start=3.125:end=3.825,setpts=PTS-STARTPTS,scale=64:-2,fps=10[s2];[s0][s1][s2]concat=n=3:v=1:a=0,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a[out]".into(), "-map".into(), "[out]".into(), "-an".into(), "-loop".into(), "-1".into()];
        let output = temp.path().join(format!("seek-{timestamp_offset}.gif"));
        let original = temp
            .path()
            .join(format!("reference-{timestamp_offset}.gif"));
        encode_plan(&rt, &plan, &output);
        encode_plan(&rt, &reference, &original);
        assert!(
            decoded(&rt, &output, false) == decoded(&rt, &original, false),
            "GIF frame order/timing mismatch: offset={timestamp_offset}"
        );
    }
}

#[test]
#[ignore = "explicit late-segment conversion and repeated-source planning benchmark"]
fn late_segments_and_repeated_source_planning() {
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
            "testsrc2=s=640x360:r=30:d=60",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000:duration=60",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-crf",
            "20",
            "-g",
            "300",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-threads",
            "2",
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
    let convert = json!({"kind":"convert","asset":asset,"format":"mp4","width":320,"height":180,"fps":15,"trimStart":55.25,"trimEnd":57.25});
    let gif = json!({"kind":"gif","asset":asset,"segments":[{"start":55.25,"end":56.25},{"start":40.25,"end":41.25}],"width":320,"fps":10});
    for round in 0..3 {
        for (name, spec, extension) in
            [("late-convert", &convert, "mp4"), ("late-gif", &gif, "gif")]
        {
            let started = Instant::now();
            let target = format!("{name}-{round}.{extension}");
            let (_, probe) = run(temp.path(), &rt, spec.clone(), &target);
            let elapsed = started.elapsed().as_secs_f64();
            let duration: f64 = probe["format"]["duration"]
                .as_str()
                .unwrap()
                .parse()
                .unwrap();
            assert!((duration - 2.0).abs() < 0.15, "{name}: {duration}");
            let decoded = process(&rt.encoder)
                .args(["-v", "error", "-i"])
                .arg(temp.path().join(target))
                .args(["-f", "null", "-"])
                .output()
                .unwrap();
            assert!(
                decoded.status.success(),
                "{name}: {}",
                String::from_utf8_lossy(&decoded.stderr)
            );
            eprintln!(
                "MEDIA_BENCH name={name} round={round} seconds={elapsed:.6} duration={duration}"
            );
        }
        let clips: Vec<Value> = (0..60).map(|index| json!({"id":format!("clip-{index}"),"assetId":asset.id,"start":index,"trimIn":index,"trimOut":index+1,"speed":1,"volume":1,"opacity":1,"width":640,"height":360})).collect();
        let spec = json!({"kind":"timeline","project":{"width":640,"height":360,"assets":[asset],"tracks":[{"kind":"video","clips":clips}]},"config":{"width":320,"height":180,"fps":15,"format":"mp4"}});
        let started = Instant::now();
        let plan = build_plan(&store, &rt, &spec).unwrap();
        assert_eq!(plan.duration, 60.0);
        let graph_index = plan
            .args
            .iter()
            .position(|value| value == "-filter_complex_script")
            .unwrap();
        let graph = fs::read_to_string(&plan.args[graph_index + 1]).unwrap();
        assert!(
            graph.contains("amix=inputs=60:"),
            "Every audible clip must remain in the mix"
        );
        eprintln!(
            "MEDIA_BENCH name=repeated-source-plan round={round} seconds={:.6} clips=60",
            started.elapsed().as_secs_f64()
        );
    }
}
