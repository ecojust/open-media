//! Shared timeline timing and frame expressions for native visual automation.
use crate::engine::{number, Result};
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Easing {
    #[default]
    Linear,
    EaseIn,
    EaseOut,
    EaseInOut,
    Step,
}
impl Easing {
    pub(crate) fn at(self, t: f64) -> f64 {
        let t = t.clamp(0.0, 1.0);
        match self {
            Self::Linear => t,
            Self::EaseIn => t * t,
            Self::EaseOut => 1.0 - (1.0 - t).powi(2),
            Self::EaseInOut => {
                if t < 0.5 {
                    2.0 * t * t
                } else {
                    1.0 - (-2.0 * t + 2.0).powi(2) / 2.0
                }
            }
            Self::Step => {
                if t >= 1.0 {
                    1.0
                } else {
                    0.0
                }
            }
        }
    }
    pub(crate) fn expression(self, t: &str) -> String {
        match self {
            Self::Linear => t.into(),
            Self::EaseIn => format!("pow({t},2)"),
            Self::EaseOut => format!("1-pow(1-({t}),2)"),
            Self::EaseInOut => format!("if(lt({t},0.5),2*pow({t},2),1-pow(-2*({t})+2,2)/2)"),
            Self::Step => format!("gte({t},1)"),
        }
    }
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Frame {
    time: f64,
    value: f64,
    #[serde(default)]
    easing: Easing,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RampPoint {
    position: f64,
    speed: f64,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Ramp {
    points: Vec<RampPoint>,
    #[serde(default)]
    easing: Easing,
    #[serde(default = "yes")]
    preserve_pitch: bool,
    source_range: Option<SourceRange>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SourceRange {
    start: f64,
    end: f64,
}
fn yes() -> bool {
    true
}
#[derive(Clone, Debug)]
pub(crate) struct Segment {
    pub source_start: f64,
    pub source_end: f64,
    pub time_start: f64,
    pub time_end: f64,
    pub speed: f64,
}

pub(crate) fn speed_segments(clip: &Value) -> Result<Vec<Segment>> {
    let speed = number(clip, "speed", 1.0, 0.1, 16.0)?;
    let input = number(clip, "trimIn", 0.0, 0.0, 86400.0)?;
    let output = number(clip, "trimOut", 1.0, input, 86400.0)?;
    let span = output - input;
    let Some(value) = clip.get("speedRamp") else {
        return Ok(vec![Segment {
            source_start: input,
            source_end: output,
            time_start: 0.0,
            time_end: span / speed,
            speed,
        }]);
    };
    let ramp: Ramp = serde_json::from_value(value.clone()).map_err(|_| "变速曲线格式无效。")?;
    if clip.get("freezeFrame").is_some() {
        return Err("定格片段不能同时应用变速曲线。".into());
    }
    if !(2..=16).contains(&ramp.points.len())
        || ramp.points.first().map(|p| p.position) != Some(0.0)
        || ramp.points.last().map(|p| p.position) != Some(1.0)
    {
        return Err("变速曲线需要2至16个点并包含首尾端点。".into());
    }
    let mut previous = -1.0;
    for point in &ramp.points {
        if !point.position.is_finite()
            || point.position <= previous
            || point.position > 1.0
            || !point.speed.is_finite()
            || !(0.1..=16.0).contains(&point.speed)
        {
            return Err("变速曲线位置或速度无效。".into());
        }
        previous = point.position;
    }
    let range_start = ramp.source_range.as_ref().map(|r| r.start).unwrap_or(input);
    let range_end = ramp.source_range.as_ref().map(|r| r.end).unwrap_or(output);
    if !range_start.is_finite()
        || !range_end.is_finite()
        || range_start < 0.0
        || range_end <= range_start
        || range_end > 86400.0
    {
        return Err("变速曲线源范围无效。".into());
    }
    let range_span = range_end - range_start;
    let mut positions: Vec<f64> = (0..=32)
        .map(|i| i as f64 / 32.0)
        .chain(ramp.points.iter().map(|p| p.position))
        .collect();
    positions.sort_by(f64::total_cmp);
    positions.dedup();
    let mut time = 0.0;
    let mut segments = Vec::new();
    let mut intervals = Vec::new();
    if input < range_start {
        intervals.push((input, output.min(range_start), ramp.points[0].speed));
    }
    for pair in positions.windows(2) {
        let middle = (pair[0] + pair[1]) / 2.0;
        let points = ramp
            .points
            .windows(2)
            .find(|pair| middle <= pair[1].position)
            .ok_or("变速曲线不完整。")?;
        let factor = points[0].speed
            + (points[1].speed - points[0].speed)
                * ramp
                    .easing
                    .at((middle - points[0].position) / (points[1].position - points[0].position));
        let start = (range_start + range_span * pair[0]).max(input);
        let end = (range_start + range_span * pair[1]).min(output);
        if end > start {
            intervals.push((start, end, factor));
        }
    }
    if output > range_end {
        intervals.push((
            input.max(range_end),
            output,
            ramp.points.last().unwrap().speed,
        ));
    }
    for (start, end, factor) in intervals {
        if end <= start {
            continue;
        }
        let actual = speed * factor;
        let next = time + (end - start) / actual;
        segments.push(Segment {
            source_start: start,
            source_end: end,
            time_start: time,
            time_end: next,
            speed: actual,
        });
        time = next;
    }
    if !time.is_finite() || time > 86400.0 {
        return Err("变速后片段超过24小时。".into());
    }
    Ok(segments)
}
pub(crate) fn duration(clip: &Value) -> Result<f64> {
    Ok(speed_segments(clip)?
        .last()
        .ok_or("片段时间无效。")?
        .time_end)
}

fn keyframes(clip: &Value) -> Result<BTreeMap<String, Vec<Frame>>> {
    let Some(value) = clip.get("keyframes") else {
        return Ok(BTreeMap::new());
    };
    let frames: BTreeMap<String, Vec<Frame>> =
        serde_json::from_value(value.clone()).map_err(|_| "关键帧格式无效。")?;
    for (property, list) in &frames {
        let (min, max) = match property.as_str() {
            "x" | "y" => (-65536.0, 65536.0),
            "scaleX" | "scaleY" => (0.01, 16.0),
            "opacity" => (0.0, 1.0),
            "volume" => (0.0, 2.0),
            "rotation" => (-3600.0, 3600.0),
            _ => return Err("关键帧属性无效。".into()),
        };
        if list.is_empty() || list.len() > 128 {
            return Err("每个属性需要1至128个关键帧。".into());
        }
        let mut previous = -1.0;
        for frame in list {
            if !frame.time.is_finite()
                || frame.time < 0.0
                || frame.time <= previous
                || frame.time > 86400.0
                || !frame.value.is_finite()
                || frame.value < min
                || frame.value > max
            {
                return Err("关键帧时间或数值无效。".into());
            }
            previous = frame.time;
        }
    }
    Ok(frames)
}
fn expression_for(frames: Option<&Vec<Frame>>, fallback: f64, clock: &str) -> String {
    let Some(frames) = frames else {
        return fallback.to_string();
    };
    let mut expression = frames.last().unwrap().value.to_string();
    for pair in frames.windows(2).rev() {
        let from = &pair[0];
        let to = &pair[1];
        let progress = format!(
            "clip((({clock})-{})/{},0,1)",
            from.time,
            to.time - from.time
        );
        let value = format!(
            "{}+({})*({})",
            from.value,
            to.value - from.value,
            from.easing.expression(&progress)
        );
        expression = format!("if(lt({clock},{}),{value},{expression})", to.time);
    }
    format!("if(lt({clock},{}),{fallback},{expression})", frames[0].time)
}
pub(crate) fn expression(
    clip: &Value,
    property: &str,
    fallback: f64,
    clock: &str,
) -> Result<String> {
    let offset = number(clip, "animationOffset", 0.0, 0.0, 86400.0)?;
    Ok(expression_for(
        keyframes(clip)?.get(property),
        fallback,
        &format!("({clock})+{offset}"),
    ))
}
pub(crate) fn has_keyframe(clip: &Value, property: &str) -> bool {
    clip.get("keyframes")
        .and_then(|v| v.get(property))
        .is_some()
}

pub(crate) fn crop_filter(clip: &Value) -> Result<String> {
    let Some(crop) = clip.get("crop") else {
        return Ok(String::new());
    };
    if crop.as_object().is_none_or(|r| {
        r.keys()
            .any(|k| !["x", "y", "width", "height"].contains(&k.as_str()))
    }) {
        return Err("源画面裁剪区域无效。".into());
    }
    let x = number(crop, "x", 0.0, 0.0, 1.0)?;
    let y = number(crop, "y", 0.0, 0.0, 1.0)?;
    let width = number(crop, "width", 1.0, 0.001, 1.0)?;
    let height = number(crop, "height", 1.0, 0.001, 1.0)?;
    if x + width > 1.000000001 || y + height > 1.000000001 {
        return Err("源画面裁剪超出素材。".into());
    }
    Ok(format!(
        ",crop=w='max(1,iw*{width})':h='max(1,ih*{height})':x='iw*{x}':y='ih*{y}':exact=1"
    ))
}
pub(crate) fn video_timing(clip: &Value) -> Result<String> {
    let segments = speed_segments(clip)?;
    if let Some(freeze) = clip.get("freezeFrame") {
        let time = number(freeze, "sourceTime", 0.0, 0.0, 86400.0)?;
        let duration = duration(clip)?;
        // End the decoder branch after the chosen frame. A select filter would
        // discard every remaining source frame before tpad could observe EOF.
        return Ok(format!("trim=start={time},setpts=PTS-STARTPTS,trim=end_frame=1,tpad=stop_mode=clone:stop_duration={duration},trim=duration={duration},setpts=PTS-STARTPTS"));
    }
    let first = segments.first().ok_or("片段时间无效。")?;
    let last = segments.last().unwrap();
    let mut mapping = format!(
        "{}+(T-{})/{}",
        last.time_start,
        last.source_start - first.source_start,
        last.speed
    );
    for segment in segments.iter().rev().skip(1) {
        mapping = format!(
            "if(lt(T,{}),{}+(T-{})/{},{mapping})",
            segment.source_end - first.source_start,
            segment.time_start,
            segment.source_start - first.source_start,
            segment.speed
        );
    }
    Ok(format!(
        "trim=start={}:end={},setpts=PTS-STARTPTS,setpts='({mapping})/TB'",
        first.source_start, last.source_end
    ))
}
pub(crate) fn source_time(clip: &Value, time: f64) -> Result<f64> {
    if let Some(freeze) = clip.get("freezeFrame") { return number(freeze, "sourceTime", 0.0, 0.0, 86400.0); }
    let segments = speed_segments(clip)?;
    let segment = segments.iter().find(|segment| time < segment.time_end).or_else(|| segments.last()).ok_or("片段时间无效。")?;
    Ok((segment.source_start + (time-segment.time_start).clamp(0.0, segment.time_end-segment.time_start)*segment.speed).min(segment.source_end))
}
/// Decode only the source interval, retaining the clip's original local clock.
pub(crate) fn video_timing_window(clip: &Value, from: f64, to: f64, input_seek: f64) -> Result<String> {
    if clip.get("freezeFrame").is_some() {
        let source = source_time(clip, from)? - input_seek;
        return Ok(format!("trim=start={source},trim=end_frame=1,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration={},trim=duration={},settb=AVTB,setpts=PTS+{from}/TB",to-from,to-from));
    }
    let source_from = source_time(clip,from)? - input_seek;
    let source_to = source_time(clip,to)? - input_seek;
    let segments = speed_segments(clip)?;
    let last = segments.last().ok_or("片段时间无效。")?;
    let mut mapping = format!("{}+(T+{input_seek}-{})/{}",last.time_start,last.source_start,last.speed);
    for segment in segments.iter().rev().skip(1) {
        mapping = format!("if(lt(T+{input_seek},{}),{}+(T+{input_seek}-{})/{},{mapping})",segment.source_end,segment.time_start,segment.source_start,segment.speed);
    }
    Ok(format!("trim=start={source_from}:end={source_to},settb=AVTB,setpts='({mapping})/TB'"))
}
pub(crate) fn window_clip(clip: &Value, from: f64, to: f64) -> Result<Value> {
    let mut trimmed = clip.clone();
    if trimmed.get("speedRamp").is_some() && trimmed["speedRamp"].get("sourceRange").is_none() {
        trimmed["speedRamp"]["sourceRange"] = serde_json::json!({"start":clip["trimIn"],"end":clip["trimOut"]});
    }
    trimmed["trimIn"] = serde_json::json!(source_time(clip,from)?);
    trimmed["trimOut"] = serde_json::json!(source_time(clip,to)?);
    Ok(trimmed)
}
fn tempo(mut speed: f64) -> String {
    let mut filters = Vec::new();
    while speed > 2.0 {
        filters.push("atempo=2".to_string());
        speed /= 2.0;
    }
    while speed < 0.5 {
        filters.push("atempo=0.5".to_string());
        speed /= 0.5;
    }
    filters.push(format!("atempo={speed}"));
    filters.join(",")
}
pub(crate) fn audio_timing_seek(clip: &Value, index: usize, filters: &mut Vec<String>, input_seek: f64) -> Result<String> {
    let input = if input_seek > 0.0 {
        filters.push(format!("[{index}:a]asetpts=PTS+{input_seek}/TB[seek_audio{index}]"));
        format!("[seek_audio{index}]")
    } else { format!("[{index}:a]") };
    let mut segments: Vec<Segment> = Vec::new();
    for segment in speed_segments(clip)? {
        if let Some(previous) = segments.last_mut().filter(|previous| {
            previous.speed == segment.speed
                && (previous.source_end - segment.source_start).abs() < 1e-9
        }) {
            previous.source_end = segment.source_end;
            previous.time_end = segment.time_end;
        } else {
            segments.push(segment);
        }
    }
    let preserve = clip
        .get("speedRamp")
        .map(|value| serde_json::from_value::<Ramp>(value.clone()).map(|r| r.preserve_pitch))
        .transpose()
        .map_err(|_| "变速曲线格式无效。")?
        .unwrap_or(true);
    if segments.len() == 1 {
        let s = &segments[0];
        let rate = if preserve {
            tempo(s.speed)
        } else {
            format!("aresample=48000,asetrate=48000*{},aresample=48000", s.speed)
        };
        return Ok(format!(
            "{input}atrim=start={}:end={},asetpts=PTS-STARTPTS,{rate}",
            s.source_start, s.source_end
        ));
    }
    let input_labels = (0..segments.len())
        .map(|i| format!("[ramp{index}_in{i}]"))
        .collect::<String>();
    filters.push(format!(
        "{input}asplit={}{input_labels}",
        segments.len()
    ));
    if segments
        .iter()
        .any(|segment| segment.time_end - segment.time_start < 1.0 / 48000.0)
    {
        return Err("变速曲线的音频分段短于一个采样点，请降低速度或延长片段。".into());
    }
    let overlaps: Vec<f64> = segments
        .windows(2)
        .map(|pair| {
            let seconds = 0.01_f64
                .min((pair[0].time_end - pair[0].time_start) / 4.0)
                .min((pair[1].time_end - pair[1].time_start) / 4.0);
            (seconds * 48000.0).round().max(1.0) / 48000.0
        })
        .collect();
    for (i, s) in segments.iter().enumerate() {
        let rate = if preserve {
            tempo(s.speed)
        } else {
            format!("aresample=48000,asetrate=48000*{},aresample=48000", s.speed)
        };
        // Tempo filters need context; processing tiny curve bins in isolation
        // produces near-empty audio blocks and audible gaps between every bin.
        let context = if preserve { 0.25 * s.speed } else { 0.0 };
        let before = if i > 0 { overlaps[i - 1] / 2.0 } else { 0.0 };
        let after = overlaps.get(i).copied().unwrap_or(0.0) / 2.0;
        let wanted_start = s.source_start - before * s.speed;
        // A range decoder may begin inside the normal tempo preroll. Compute
        // the trim offset from the samples actually available after input seek.
        let source_start = (wanted_start - context).max(input_seek).max(0.0);
        let source_end = s.source_end + after * s.speed + context;
        let offset = (wanted_start - source_start) / s.speed;
        let length = s.time_end - s.time_start + before + after;
        filters.push(format!("[ramp{index}_in{i}]atrim=start={source_start}:end={source_end},asetpts=PTS-STARTPTS,{rate},aresample=48000,atrim=start={offset}:duration={length},asetpts=PTS-STARTPTS,apad=whole_dur={length},atrim=duration={length}[ramp{index}_out{i}]"));
    }
    let mut previous = format!("ramp{index}_out0");
    for (i, overlap) in overlaps.iter().enumerate() {
        let mixed = format!("ramp{index}_mix{i}");
        filters.push(format!(
            "[{previous}][ramp{index}_out{}]acrossfade=ns={}:c1=tri:c2=tri[{mixed}]",
            i + 1,
            (overlap * 48000.0).round() as u64
        ));
        previous = mixed;
    }
    Ok(format!("[{previous}]anull"))
}

/// Fixed-size inverse affine sampling avoids changing frame dimensions during playback.
#[cfg(test)]
pub(crate) fn visual_filter(clip: &Value, cw: u32, ch: u32, fps: f64) -> Result<String> {
    visual_filter_at(clip, cw, ch, fps, None)
}
pub(crate) fn visual_filter_at(clip: &Value, cw: u32, ch: u32, fps: f64, frame_time: Option<f64>) -> Result<String> {
    let frames = keyframes(clip)?;
    let transformed = ["scaleX", "scaleY", "rotation"]
        .iter()
        .any(|name| frames.contains_key(*name));
    let opacity = number(clip, "opacity", 1.0, 0.0, 1.0)?;
    if !transformed && !frames.contains_key("opacity") {
        return Ok(String::new());
    }
    let start = number(clip, "start", 0.0, 0.0, 86400.0)?;
    let clock = format!(
        "{}-{start}+{}",
        frame_time.map_or_else(|| "T".to_string(), |time| time.to_string()),
        number(clip, "animationOffset", 0.0, 0.0, 86400.0)?
    );
    let alpha = expression_for(frames.get("opacity"), opacity, &clock);
    let resample = if frame_time.is_some() { String::new() } else { format!(",fps={fps}") };
    let mut prefix = format!(",settb=AVTB,setpts=PTS+{start}/TB{resample},settb=AVTB,format=rgba");
    let rotation = number(clip,"rotation",0.0,-3600.0,3600.0)?;
    let scale_only = rotation == 0.0 && frames.get("rotation").is_none_or(|list| list.iter().all(|frame|frame.value==0.0));
    if transformed && scale_only {
        // Native scaling is vectorized; a square affine canvas evaluates millions
        // of transparent pixels per frame for ordinary focus/zoom animation.
        let max_scale = |name: &str| frames.get(name).map(|list|list.iter().map(|frame|frame.value).fold(1.0,f64::max)).unwrap_or(1.0);
        let max_w = cw as f64 * max_scale("scaleX"); let max_h = ch as f64 * max_scale("scaleY");
        if max_w>16384.0 || max_h>16384.0 || max_w*max_h>32_000_000.0 { return Err("动画中间画布超过3200万像素，请减小片段尺寸或缩放关键帧。".into()); }
        let scale_clock = clock.replace('T', "t");
        let sx = expression_for(frames.get("scaleX"),1.0,&scale_clock);
        let sy = expression_for(frames.get("scaleY"),1.0,&scale_clock);
        prefix += &format!(",scale=w='max(1,round({cw}*({sx})))':h='max(1,round({ch}*({sy})))':eval=frame:flags=bilinear,setsar=1");
        if frames.contains_key("opacity") {
            prefix += &format!(",format=gbrap,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*({alpha})',format=rgba");
        } else { prefix += &format!(",colorchannelmixer=aa={opacity}"); }
        prefix += &format!(",setpts=PTS-{start}/TB");
        return Ok(prefix);
    }
    let (x, y, mask) = if transformed {
        let max_x = frames
            .get("scaleX")
            .map(|v| v.iter().map(|f| f.value).fold(1.0, f64::max))
            .unwrap_or(1.0);
        let max_y = frames
            .get("scaleY")
            .map(|v| v.iter().map(|f| f.value).fold(1.0, f64::max))
            .unwrap_or(1.0);
        let extent = ((cw as f64 * max_x).hypot(ch as f64 * max_y)).ceil() as u32 + 2;
        if extent > 16384 || u64::from(extent) * u64::from(extent) > 32_000_000 {
            return Err("动画中间画布超过3200万像素，请减小片段尺寸或缩放关键帧。".into());
        }
        prefix += &format!(",pad={extent}:{extent}:(ow-iw)/2:(oh-ih)/2:color=0x00000000");
        let sx = expression_for(frames.get("scaleX"), 1.0, &clock);
        let sy = expression_for(frames.get("scaleY"), 1.0, &clock);
        let angle = expression_for(
            frames.get("rotation"),
            number(clip, "rotation", 0.0, -3600.0, 3600.0)?,
            &clock,
        );
        let radians = format!("({angle})*PI/180");
        let x = format!("((X-W/2)*cos({radians})+(Y-H/2)*sin({radians}))/({sx})+W/2");
        let y = format!("(-(X-W/2)*sin({radians})+(Y-H/2)*cos({radians}))/({sy})+H/2");
        let mask = format!(
            "gte({x},(W-{cw})/2)*lt({x},(W+{cw})/2)*gte({y},(H-{ch})/2)*lt({y},(H+{ch})/2)"
        );
        (x, y, mask)
    } else {
        ("X".into(), "Y".into(), "1".into())
    };
    prefix+=&format!(",format=gbrap,geq=r='r({x},{y})':g='g({x},{y})':b='b({x},{y})':a='alpha({x},{y})*({mask})*({alpha})',format=rgba,setpts=PTS-{start}/TB");
    Ok(prefix)
}
pub(crate) fn transformed(clip: &Value) -> bool {
    ["scaleX", "scaleY", "rotation"]
        .iter()
        .any(|key| has_keyframe(clip, key))
}

pub(crate) fn append_blur_overlay(
    clip: &Value,
    filters: &mut Vec<String>,
    base: usize,
    width: u32,
    height: u32,
    project_w: f64,
    project_h: f64,
    duration: f64,
) -> Result<()> {
    let start = number(clip, "start", 0.0, 0.0, 86400.0)?;
    let local = format!("T-{start}");
    let ratio_x = width as f64 / project_w;
    let ratio_y = height as f64 / project_h;
    let cw = number(clip, "width", project_w, 1.0, 30000.0)? * ratio_x;
    let ch = number(clip, "height", project_h, 1.0, 30000.0)? * ratio_y;
    let x = expression(
        clip,
        "x",
        number(clip, "x", 0.0, -30000.0, 30000.0)?,
        &local,
    )?;
    let y = expression(
        clip,
        "y",
        number(clip, "y", 0.0, -30000.0, 30000.0)?,
        &local,
    )?;
    let sx = expression(clip, "scaleX", 1.0, &local)?;
    let sy = expression(clip, "scaleY", 1.0, &local)?;
    let rotation = expression(
        clip,
        "rotation",
        number(clip, "rotation", 0.0, -3600.0, 3600.0)?,
        &local,
    )?;
    let alpha = expression(
        clip,
        "opacity",
        number(clip, "opacity", 1.0, 0.0, 1.0)?,
        &local,
    )?;
    let radius =
        number(&clip["overlay"], "blurRadius", 12.0, 1.0, 50.0)? * (ratio_x * ratio_y).sqrt();
    let dx = format!("X-(({x})*{ratio_x}+{cw}/2)");
    let dy = format!("Y-(({y})*{ratio_y}+{ch}/2)");
    let angle = format!("({rotation})*PI/180");
    let rx = format!("({dx})*cos({angle})+({dy})*sin({angle})");
    let ry = format!("-({dx})*sin({angle})+({dy})*cos({angle})");
    let fade_in = number(clip, "fadeIn", 0.0, 0.0, duration)?;
    let fade_out = number(clip, "fadeOut", 0.0, 0.0, duration)?;
    let peak = if fade_in + fade_out > duration {
        duration / (fade_in + fade_out)
    } else {
        1.0
    };
    let mut fade = peak.to_string();
    if fade_in > 0.0 {
        fade += &format!("*clip((T-{start})/{},0,1)", fade_in * peak);
    }
    if fade_out > 0.0 {
        fade += &format!("*clip(({}-T)/{},0,1)", start + duration, fade_out * peak);
    }
    let mask=format!("lt(abs({rx}),{cw}*({sx})/2)*lt(abs({ry}),{ch}*({sy})/2)*gte(T,{start})*lt(T,{})*({alpha})*({fade})",start+duration);
    filters.push(format!(
        "[base{base}]split[blur_clean{base}][blur_source{base}]"
    ));
    filters.push(format!("[blur_source{base}]gblur=sigma={radius}:steps=2,format=gbrap,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*({mask})',format=rgba[blur_layer{base}]"));
    filters.push(format!(
        "[blur_clean{base}][blur_layer{base}]overlay=0:0:eof_action=pass:format=auto[base{}]",
        base + 1
    ));
    Ok(())
}

#[cfg(test)]
#[path = "clip_animation_tests.rs"]
mod tests;
