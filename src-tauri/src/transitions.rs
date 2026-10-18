use crate::clip_animation::Easing;
use crate::engine::{number, Result};
use serde::Deserialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

const EPSILON: f64 = 0.000001;

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Effect {
    Fade,
    WipeUp,
    WipeDown,
    WipeLeft,
    WipeRight,
    CloseVertical,
    CloseHorizontal,
    SlideLeft,
    SlideRight,
    Zoom,
    ZoomFade,
    ZoomFadeLeft,
    ZoomFadeRight,
    ZoomFadeUp,
    ZoomFadeDown,
}
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Direction {
    Up,
    Down,
    Left,
    Right,
}
#[derive(Clone, Copy, Debug, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
enum Scope {
    #[default]
    Both,
    Outgoing,
    Incoming,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Binding {
    effect: Effect,
    from_clip_id: String,
    to_clip_id: String,
    direction: Option<Direction>,
    #[serde(default)]
    easing: Easing,
    color: Option<String>,
    #[serde(default)]
    blur: f64,
    #[serde(default)]
    scope: Scope,
}

struct Half {
    effect: Effect,
    start: f64,
    end: f64,
    incoming: bool,
    direction: Option<Direction>,
    easing: Easing,
    color: Option<String>,
    blur: f64,
}

#[derive(Default)]
pub(super) struct Transitions(HashMap<String, Vec<Half>>);

fn timing(clip: &Value) -> Result<(f64, f64)> {
    let start = number(clip, "start", 0.0, 0.0, 86400.0)?;
    Ok((start, crate::clip_animation::duration(clip)?))
}

impl Transitions {
    pub(super) fn from_project(project: &Value) -> Result<Self> {
        let tracks = project["tracks"].as_array().ok_or("时间线轨道无效。")?;
        let assets = project["assets"].as_array().ok_or("素材列表无效。")?;
        let fps = number(project, "fps", 30.0, 1.0, 240.0)?;
        let mut sources = HashMap::new();
        for (track_index, track) in tracks.iter().enumerate() {
            if track["kind"] != "video" {
                continue;
            }
            let mut clips: Vec<_> = track["clips"]
                .as_array()
                .ok_or("轨道片段无效。")?
                .iter()
                .collect();
            clips.sort_by(|a, b| {
                let (a_start, a_duration) = timing(a).unwrap_or_default();
                let (b_start, b_duration) = timing(b).unwrap_or_default();
                a_start
                    .total_cmp(&b_start)
                    .then_with(|| a_duration.total_cmp(&b_duration))
            });
            for (clip_index, clip) in clips.into_iter().enumerate() {
                // Legacy exports do not need IDs unless another clip refers to them.
                let Some(id) = clip["id"].as_str() else {
                    continue;
                };
                if sources
                    .insert(id, (track_index, clip_index, clip))
                    .is_some()
                {
                    return Err("视频片段标识重复，请重新打开项目后导出。".into());
                }
            }
        }
        let mut result = Self::default();
        let mut pairs = HashSet::new();
        let mut count = 0;
        for track in tracks.iter().filter(|track| track["kind"] == "transition") {
            for clip in track["clips"].as_array().ok_or("转场轨道片段无效。")? {
                count += 1;
                if count > 500 {
                    return Err("转场片段数量超出支持范围。".into());
                }
                let binding: Binding = serde_json::from_value(clip["transition"].clone())
                    .map_err(|_| "转场类型或关联片段无效，请重新添加转场。")?;
                if !binding.blur.is_finite()
                    || !(0.0..=50.0).contains(&binding.blur)
                    || binding.color.as_ref().is_some_and(|color| {
                        color.len() != 7
                            || !color.starts_with('#')
                            || !color[1..].chars().all(|c| c.is_ascii_hexdigit())
                    })
                {
                    return Err("转场颜色或模糊参数无效。".into());
                }
                let from = sources
                    .get(binding.from_clip_id.as_str())
                    .ok_or("转场的前一个视频片段已丢失。")?;
                let to = sources
                    .get(binding.to_clip_id.as_str())
                    .ok_or("转场的后一个视频片段已丢失。")?;
                if from.0 != to.0 || from.1 + 1 != to.1 {
                    return Err("转场需要关联同一视频轨道中相邻的两个片段。".into());
                }
                for source in [from.2, to.2] {
                    if !assets
                        .iter()
                        .any(|asset| asset["id"] == source["assetId"] && asset["kind"] == "video")
                    {
                        return Err("转场只能关联视频素材片段。".into());
                    }
                }
                let (from_start, from_duration) = timing(from.2)?;
                let (to_start, to_duration) = timing(to.2)?;
                let cut = from_start + from_duration;
                let (start, duration) = timing(clip)?;
                if (cut - to_start).abs() > EPSILON {
                    return Err("转场两侧的视频片段必须首尾相接。".into());
                }
                for other in tracks[from.0]["clips"]
                    .as_array()
                    .ok_or("视频轨道片段无效。")?
                {
                    if other["id"] == binding.from_clip_id || other["id"] == binding.to_clip_id {
                        continue;
                    }
                    let (other_start, other_duration) = timing(other)?;
                    if other_start < cut - EPSILON && other_start + other_duration > cut + EPSILON {
                        return Err("转场切点不能被同轨道的其他视频片段覆盖。".into());
                    }
                }
                if duration < 2.0 / fps - EPSILON
                    || duration > from_duration.min(to_duration) + EPSILON
                    || (start + duration / 2.0 - cut).abs() > EPSILON
                    || clip["trimIn"].as_f64().unwrap_or(0.0).abs() > EPSILON
                    || (clip["speed"].as_f64().unwrap_or(1.0) - 1.0).abs() > EPSILON
                {
                    return Err("转场应以视频切点为中心，且时长不能超过两侧较短的片段。".into());
                }
                if !pairs.insert((binding.from_clip_id.clone(), binding.to_clip_id.clone())) {
                    return Err("同一个视频切点不能重复添加转场。".into());
                }
                if track["muted"] == true {
                    continue;
                }
                let half = duration / 2.0;
                if !matches!(binding.scope, Scope::Incoming) {
                    result
                        .0
                        .entry(binding.from_clip_id)
                        .or_default()
                        .push(Half {
                            effect: binding.effect,
                            start: from_duration - half,
                            end: from_duration,
                            incoming: false,
                            direction: binding.direction,
                            easing: binding.easing,
                            color: binding.color.clone(),
                            blur: binding.blur,
                        });
                }
                if !matches!(binding.scope, Scope::Outgoing) {
                    result.0.entry(binding.to_clip_id).or_default().push(Half {
                        effect: binding.effect,
                        start: 0.0,
                        end: half,
                        incoming: true,
                        direction: binding.direction,
                        easing: binding.easing,
                        color: binding.color.clone(),
                        blur: binding.blur,
                    });
                }
            }
        }
        Ok(result)
    }

    /// Operate inside the clip rectangle before its rotation. Each half uses the
    /// existing frames and timeline duration; no source handles or overlap are needed.
    pub(super) fn append_graph(
        &self,
        clip: &Value,
        fps: f64,
        mut chain: String,
        filters: &mut Vec<String>,
        index: usize,
        frame_time: Option<f64>,
    ) -> String {
        let Some(halves) = clip["id"].as_str().and_then(|id| self.0.get(id)) else {
            return chain;
        };
        let clip_start = clip["start"].as_f64().unwrap_or(0.0);
        // Apply animated masks at the project's actual frame times. Evaluating
        // them on the source frame grid makes slowed or low-rate sources hold
        // stale mask positions across the cut. Preserve fractional clip offsets.
        let resample = if frame_time.is_some() { String::new() } else { format!(",fps={fps}") };
        chain += &format!(",settb=AVTB,setpts=PTS+{clip_start}/TB{resample},settb=AVTB");
        let clock = frame_time.map_or_else(|| "T".to_string(), |time| time.to_string());
        let enabled_clock = frame_time.map_or_else(|| "t".to_string(), |time| time.to_string());
        for (part, half) in halves.iter().enumerate() {
            let duration = half.end - half.start;
            let start = clip_start + half.start;
            let end = clip_start + half.end;
            let progress = if half.incoming {
                format!("clip(({clock}-{start})/{duration},0,1)")
            } else {
                format!("clip(({end}-{clock})/{duration},0,1)")
            };
            let v = format!("({})", half.easing.expression(&progress));
            if half.blur > 0.0 {
                chain+=&format!(",format=gbrap,split[transition_plain{index}_{part}][transition_blur{index}_{part}]");
                filters.push(chain);
                filters.push(format!("[transition_blur{index}_{part}]gblur=sigma={}:steps=2[transition_blurred{index}_{part}]",half.blur));
                filters.push(format!("[transition_plain{index}_{part}][transition_blurred{index}_{part}]blend=all_expr='A*{v}+B*(1-{v})':enable='gte({enabled_clock},{start})*lt({enabled_clock},{end})'[transition_mix{index}_{part}]"));
                chain = format!("[transition_mix{index}_{part}]null");
            }
            let mut sample_x = "X".to_string();
            let mut sample_y = "Y".to_string();
            let effect = if matches!(
                half.effect,
                Effect::WipeUp | Effect::WipeDown | Effect::WipeLeft | Effect::WipeRight
            ) {
                match half.direction {
                    Some(Direction::Up) => Effect::WipeUp,
                    Some(Direction::Down) => Effect::WipeDown,
                    Some(Direction::Left) => Effect::WipeLeft,
                    Some(Direction::Right) => Effect::WipeRight,
                    None => half.effect,
                }
            } else {
                half.effect
            };
            let mask = match effect {
                Effect::Fade => v.clone(),
                Effect::WipeUp => format!("gte(Y,H*(1-{v}))"),
                Effect::WipeDown => format!("lt(Y,H*{v})"),
                Effect::WipeLeft => format!("gte(X,W*(1-{v}))"),
                Effect::WipeRight => format!("lt(X,W*{v})"),
                Effect::CloseVertical => format!("gte(Y,H*(1-{v})/2)*lt(Y,H*(1+{v})/2)"),
                Effect::CloseHorizontal => format!("gte(X,W*(1-{v})/2)*lt(X,W*(1+{v})/2)"),
                Effect::SlideLeft | Effect::SlideRight => {
                    match half
                        .direction
                        .unwrap_or(if matches!(effect, Effect::SlideLeft) {
                            Direction::Left
                        } else {
                            Direction::Right
                        }) {
                        Direction::Up => {
                            sample_y = format!("Y+H*(1-{v})");
                            format!("lt({sample_y},H)")
                        }
                        Direction::Down => {
                            sample_y = format!("Y-H*(1-{v})");
                            format!("gte({sample_y},0)")
                        }
                        Direction::Left => {
                            sample_x = format!("X+W*(1-{v})");
                            format!("lt({sample_x},W)")
                        }
                        Direction::Right => {
                            sample_x = format!("X-W*(1-{v})");
                            format!("gte({sample_x},0)")
                        }
                    }
                }
                Effect::Zoom => {
                    sample_x = format!("(X-W/2)/max({v},0.000001)+W/2");
                    sample_y = format!("(Y-H/2)/max({v},0.000001)+H/2");
                    format!(
                        "gte({sample_x},0)*lt({sample_x},W)*gte({sample_y},0)*lt({sample_y},H)*{v}"
                    )
                }
                Effect::ZoomFade
                | Effect::ZoomFadeLeft
                | Effect::ZoomFadeRight
                | Effect::ZoomFadeUp
                | Effect::ZoomFadeDown => {
                    // Keep the preset's anchor fixed inside the clip rectangle.
                    // Visibility controls alpha independently from the gentle
                    // 100%–80% scale; existing Zoom retains its 100%–0% range.
                    let anchor_x = match effect {
                        Effect::ZoomFadeLeft => "0",
                        Effect::ZoomFadeRight => "W",
                        _ => "W/2",
                    };
                    let anchor_y = match effect {
                        Effect::ZoomFadeUp => "0",
                        Effect::ZoomFadeDown => "H",
                        _ => "H/2",
                    };
                    let scale = format!("(0.8+0.2*{v})");
                    sample_x = format!("(X-({anchor_x}))/{scale}+({anchor_x})");
                    sample_y = format!("(Y-({anchor_y}))/{scale}+({anchor_y})");
                    format!(
                        "gte({sample_x},0)*lt({sample_x},W)*gte({sample_y},0)*lt({sample_y},H)*{v}"
                    )
                }
            };
            if let Some(color) = half
                .color
                .as_ref()
                .filter(|_| matches!(effect, Effect::Fade))
            {
                let red = u8::from_str_radix(&color[1..3], 16).unwrap();
                let green = u8::from_str_radix(&color[3..5], 16).unwrap();
                let blue = u8::from_str_radix(&color[5..7], 16).unwrap();
                let mix = format!("alpha(X,Y)/255*{v}");
                chain+=&format!(",format=gbrap,geq=r='r(X,Y)*({mix})+{red}*(1-({mix}))':g='g(X,Y)*({mix})+{green}*(1-({mix}))':b='b(X,Y)*({mix})+{blue}*(1-({mix}))':a='255':enable='gte({enabled_clock},{start})*lt({enabled_clock},{end})',format=rgba");
            } else {
                chain += &format!(",format=gbrap,geq=r='r({sample_x},{sample_y})':g='g({sample_x},{sample_y})':b='b({sample_x},{sample_y})':a='alpha({sample_x},{sample_y})*({mask})':enable='gte({enabled_clock},{start})*lt({enabled_clock},{end})',format=rgba");
            }
        }
        chain += &format!(",setpts=PTS-{clip_start}/TB");
        chain
    }
}
