//! Production encoder checks for the same bottom-to-top order shown in the editor.
use super::*;

fn png_asset(
    store: &MediaStore,
    rt: &Runtime,
    name: &str,
    color: impl Fn(u32, u32) -> [u8; 4],
) -> Asset {
    let path = store.root.join(name);
    let mut bytes = Vec::new();
    for y in 0..40 {
        for x in 0..40 {
            bytes.extend_from_slice(&color(x, y));
        }
    }
    let mut encoder = png::Encoder::new(fs::File::create(&path).unwrap(), 40, 40);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder
        .write_header()
        .unwrap()
        .write_image_data(&bytes)
        .unwrap();
    store.import(rt, &path, None).unwrap()
}

fn layer_fixture(store: &MediaStore, rt: &Runtime) -> Value {
    let video = sample(&store.root, rt);
    let title = png_asset(store, rt, "title.png", |_, _| [255, 255, 0, 255]);
    let image = png_asset(store, rt, "decoration.png", |x, y| {
        [0, 255, 0, if x >= 10 && y >= 10 { 255 } else { 0 }]
    });
    let keyed = png_asset(store, rt, "green-effect.png", |x, _| {
        if x < 20 {
            [0, 255, 0, 255]
        } else {
            [0, 0, 255, 255]
        }
    });
    let visual = |id: &str, asset: &Asset, x: u32, y: u32, width: u32, height: u32| {
        json!({"id":id,"assetId":asset.id,"start":0,"trimIn":0,"trimOut":0.8,
            "speed":1,"volume":0,"opacity":1,"x":x,"y":y,"width":width,"height":height,
            "fit":"fill","rotation":0,"fadeIn":0,"fadeOut":0})
    };
    let mut green = visual("keyed", &keyed, 80, 10, 40, 40);
    green["chromaKey"] = json!({"enabled":true,"color":"#00ff00","similarity":0.18,"blend":0.08});
    json!({
        "kind":"timeline",
        "project":{"width":160,"height":120,"fps":20,"background":"#000000",
            "assets":[video,image,keyed],
            "tracks":[
                {"id":"base","kind":"video","clips":[visual("base",&video,0,0,160,120)]},
                {"id":"title","kind":"text","clips":[visual("title",&title,20,20,40,40)]},
                {"id":"decoration","kind":"video","clips":[visual("image",&image,30,30,40,40),green]}
            ]},
        "textAssets":{"title":title},
        "config":{"format":"mp4","width":160,"height":120,"fps":20,"quality":"high"}
    })
}

fn frame_pixels(rt: &Runtime, path: &Path) -> Vec<u8> {
    let output = process(&rt.encoder)
        .args(["-v", "error", "-i"])
        .arg(path)
        .args([
            "-frames:v",
            "1",
            "-threads",
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
    assert_eq!(output.stdout.len(), 160 * 120 * 3);
    output.stdout
}

fn color_at(bytes: &[u8], x: usize, y: usize, expected: [u8; 3]) {
    let actual = &bytes[(y * 160 + x) * 3..][..3];
    assert!(
        actual
            .iter()
            .zip(expected)
            .all(|(a, e)| a.abs_diff(e) <= 18),
        "pixel ({x}, {y}) expected {expected:?}, got {actual:?}"
    );
}

fn assert_original_stack(bytes: &[u8]) {
    color_at(bytes, 10, 10, [255, 0, 0]);
    color_at(bytes, 25, 25, [255, 255, 0]);
    color_at(bytes, 35, 35, [255, 255, 0]); // Transparent image corner reveals title.
    color_at(bytes, 45, 45, [0, 255, 0]); // Later image covers the earlier text.
    color_at(bytes, 65, 65, [0, 255, 0]);
    color_at(bytes, 85, 25, [255, 0, 0]); // Green-key transparency reveals base.
    color_at(bytes, 110, 25, [0, 0, 255]);
}

#[test]
fn native_track_order_controls_video_text_and_transparent_image_stacking() {
    let root = tempfile::tempdir().unwrap();
    let rt = runtime();
    let store = MediaStore::new(root.path()).unwrap();
    let spec = layer_fixture(&store, &rt);
    run(root.path(), &rt, spec.clone(), "original.mp4");
    assert_original_stack(&frame_pixels(&rt, &root.path().join("original.mp4")));

    let mut reordered = spec.clone();
    reordered["project"]["tracks"]
        .as_array_mut()
        .unwrap()
        .swap(1, 2);
    run(root.path(), &rt, reordered, "text-last.mp4");
    let rgb = frame_pixels(&rt, &root.path().join("text-last.mp4"));
    color_at(&rgb, 45, 45, [255, 255, 0]);
    color_at(&rgb, 65, 65, [0, 255, 0]);

    let mut video_last = spec.clone();
    video_last["project"]["tracks"]
        .as_array_mut()
        .unwrap()
        .rotate_left(1);
    run(root.path(), &rt, video_last, "video-last.mp4");
    let rgb = frame_pixels(&rt, &root.path().join("video-last.mp4"));
    for (x, y) in [(25, 25), (45, 45), (65, 65), (110, 25)] {
        color_at(&rgb, x, y, [255, 0, 0]);
    }

    let mut hidden = spec;
    hidden["project"]["tracks"][2]["hidden"] = json!(true);
    run(root.path(), &rt, hidden, "hidden-decoration.mp4");
    let rgb = frame_pixels(&rt, &root.path().join("hidden-decoration.mp4"));
    color_at(&rgb, 45, 45, [255, 255, 0]);
    color_at(&rgb, 65, 65, [255, 0, 0]);
}

#[test]
fn native_frame_and_range_preview_match_track_stacking_and_image_placement() {
    let root = tempfile::tempdir().unwrap();
    let rt = runtime();
    let store = MediaStore::new(root.path()).unwrap();
    let spec = layer_fixture(&store, &rt);
    let jobs = JobManager::default();
    for frame_only in [true, false] {
        let request = json!({"project":spec["project"],"textAssets":spec["textAssets"],
            "frameOnly":frame_only,"start":0.3,"end":0.6,"width":160,"fps":20});
        let pending = crate::preview_tools::begin(&store, &rt, &jobs, &request).unwrap();
        let finished = wait(&jobs, &pending.id);
        assert_eq!(finished.state, "completed", "{:?}", finished.error);
        let asset = crate::preview_tools::result(&store, &rt, &jobs, &pending.id).unwrap();
        assert_original_stack(&frame_pixels(&rt, Path::new(&asset.native_path)));
        crate::preview_tools::discard(&store, &jobs, &pending.id).unwrap();
    }
    jobs.shutdown();
}
