use super::Effect;

/// Crop the live frame once per tile, then use the native scale/rotate/overlay
/// kernels. Geometry is evaluated once per frame, never by an interpreted
/// per-pixel inverse transform, and no full-frame padding is introduced.
pub(super) fn append_graph(
    effect: Effect,
    visibility: &str,
    clock: &str,
    start: f64,
    end: f64,
    index: usize,
    part: usize,
    width: u32,
    height: u32,
    chain: &str,
    filters: &mut Vec<String>,
) -> Option<String> {
    let (cols, rows) = match effect {
        Effect::FragmentBurst
        | Effect::FragmentVortex
        | Effect::FragmentCollapse
        | Effect::TileOrbit => (8, 5),
        Effect::PixelDissolve | Effect::PixelWave => (16, 10),
        Effect::SliceStagger | Effect::ZipperSlices => (
            if matches!(effect, Effect::ZipperSlices) {
                2
            } else {
                1
            },
            12,
        ),
        Effect::SliceVertical | Effect::SteppedShutter => (12, 1),
        Effect::CheckerFlip => (10, 6),
        Effect::GlitchSlices => (1, 16),
        _ => return None,
    };
    let prefix = format!("fragment{index}_{part}");
    let cw = width as f64 / cols as f64;
    let ch = height as f64 / rows as f64;
    let v = expression_clock(visibility, 'T', 't');
    let d = format!("(1-({v}))");
    let active = format!("gte({clock},{start})*lt({clock},{end})*lt({v},0.999999)");
    let cells: Vec<_> = (0..rows)
        .flat_map(|row| (0..cols).map(move |col| (row, col)))
        .filter(|(row, col)| {
            (((col + 1) as f64 * cw).floor() as u32) > ((*col as f64 * cw).floor() as u32)
                && (((row + 1) as f64 * ch).floor() as u32) > ((*row as f64 * ch).floor() as u32)
        })
        .collect();
    let pieces = cells.len();
    filters.push(format!(
        "{chain},format=rgba,split=2[{prefix}_plain][{prefix}_pieces]"
    ));
    // Full visibility uses the untouched source, so fractional cell boundaries
    // cannot introduce a grid seam at either endpoint.
    filters.push(format!(
        "[{prefix}_plain]colorchannelmixer=aa=0:enable='{active}'[{prefix}_base0]"
    ));
    filters.push(format!(
        "[{prefix}_pieces]split={pieces}{}",
        (0..pieces)
            .map(|tile| format!("[{prefix}_source{tile}]"))
            .collect::<String>()
    ));
    for (tile, &(row, col)) in cells.iter().enumerate() {
        let h = ((col * 37 + row * 17 + col * row * 13) % 101) as f64 / 100.0;
        let bx = (col as f64 + 0.5) * cw;
        let by = (row as f64 + 0.5) * ch;
        let mut theta = "0".to_string();
        let mut phi = "0".to_string();
        let mut grid = "1".to_string();
        let mut sx = "1".to_string();
        let mut sy = "1".to_string();
        let mut offset_x = "0".to_string();
        let mut offset_y = "0".to_string();
        let opacity;
        let rotating = matches!(
            effect,
            Effect::FragmentBurst
                | Effect::FragmentVortex
                | Effect::FragmentCollapse
                | Effect::TileOrbit
        );
        if rotating {
            let scale = match effect {
                Effect::FragmentBurst => {
                    grid = format!("(1+0.9*{d})");
                    phi = format!("({}*1.2*PI*{d})", h - 0.5);
                    format!("pow({v},1.4)")
                }
                Effect::FragmentVortex => {
                    grid = format!("(1+0.65*{d})");
                    theta = format!("(1.1*{d})");
                    phi = format!("({}*PI*{d})", h - 0.5);
                    format!("pow({v},1.25)")
                }
                Effect::TileOrbit => {
                    grid = format!("(1+0.45*{d})");
                    theta = format!("(-2*{d})");
                    phi = format!("(2*{d})");
                    format!("pow({v},1.2)")
                }
                _ => {
                    grid = format!("(1-0.65*{d})");
                    theta = format!("(-0.5*{d})");
                    phi = format!("({}*0.8*PI*{d})", h - 0.5);
                    format!("{grid}*pow({v},1.1)")
                }
            };
            sx = format!("min({scale},min({grid}/(abs(cos({phi}))+{}*abs(sin({phi}))),{grid}/(abs(cos({phi}))+{}*abs(sin({phi})))))", ch/cw, cw/ch);
            sy = sx.clone();
            opacity = v.clone();
        } else {
            let delay = match effect {
                Effect::PixelDissolve => 0.45 * h,
                Effect::PixelWave => 0.3 * (col as f64 / 15.0 + row as f64 / 9.0),
                Effect::CheckerFlip => 0.25 * ((col + row) % 2) as f64,
                Effect::GlitchSlices => 0.0,
                Effect::ZipperSlices => 0.45 * row as f64 / 11.0,
                Effect::SteppedShutter => 0.55 * col as f64 / 11.0,
                _ => 0.25 * h,
            };
            let q = format!("clip(({v}-{delay})/{},0,1)", 1.0 - delay);
            opacity = match effect {
                Effect::PixelWave => format!("sqrt({q})"),
                Effect::SteppedShutter => format!("pow({q},0.25)"),
                _ => q.clone(),
            };
            match effect {
                Effect::SliceStagger => {
                    offset_x = format!("{}*(1-({q}))*{width}", if row % 2 == 0 { -1 } else { 1 })
                }
                Effect::SliceVertical => {
                    offset_y = format!("{}*(1-({q}))*{height}", if col % 2 == 0 { -1 } else { 1 })
                }
                Effect::GlitchSlices => {
                    offset_x = format!("sin(24*PI*{d}+6*PI*{h})*0.16*{d}*{width}")
                }
                Effect::ZipperSlices => {
                    offset_x = format!("{}*(1-({q}))*{width}*0.6", if col == 0 { -1 } else { 1 })
                }
                Effect::SteppedShutter => {
                    sx = q.clone();
                    offset_x = format!("(1-({q}))*{cw}/2");
                }
                Effect::CheckerFlip => {
                    sx = format!("sin(({q})*PI/2)");
                    sy = format!("(0.9+0.1*({q}))");
                }
                _ => {
                    sx = q.clone();
                    sy = q;
                }
            }
        }
        // Integer crops partition the source without overlapping ownership.
        // The exact continuous grid defines centers and destination sizes.
        let left = (col as f64 * cw).floor() as u32;
        let top = (row as f64 * ch).floor() as u32;
        let crop_w = (((col + 1) as f64 * cw).floor() as u32)
            .saturating_sub(left)
            .max(1);
        let crop_h = (((row + 1) as f64 * ch).floor() as u32)
            .saturating_sub(top)
            .max(1);
        let mut tile_chain =
            format!("[{prefix}_source{tile}]crop={crop_w}:{crop_h}:{left}:{top}:exact=1");
        if sx != "1" || sy != "1" {
            tile_chain += &format!(",scale=w='max(1,round({cw}*({sx})))':h='max(1,round({ch}*({sy})))':eval=frame:flags=bilinear");
        }
        // Keep a fixed tile container: filters after a dynamic 1 px initial
        // scale must not cache that initial size for later incoming frames.
        if sx != "1" || sy != "1" {
            let pad_w = (cw.round() as u32).max(crop_w);
            let pad_h = (ch.round() as u32).max(crop_h);
            tile_chain +=
                &format!(",pad={pad_w}:{pad_h}:'round((ow-iw)/2)':'round((oh-ih)/2)':color=black@0:eval=frame");
        }
        // Only alpha uses a short scalar expression; geometry is evaluated
        // by frame-level kernels, outside pixel loops.
        let alpha = expression_clock(&opacity, 't', 'T');
        tile_chain += &format!(",format=gbrap,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*({alpha})':enable='{active}',format=rgba");
        if rotating {
            let diameter = cw.hypot(ch).ceil() as u32 + 2;
            tile_chain += &format!(",rotate=a='({phi})+({theta})':ow={diameter}:oh={diameter}:c=black@0:enable='{active}'");
        }
        filters.push(format!("{tile_chain}[{prefix}_tile{tile}]"));
        let (cx, cy) = if rotating {
            (
                format!(
                    "{}+{grid}*({}*cos({theta})-{}*sin({theta}))",
                    width as f64 / 2.0,
                    bx - width as f64 / 2.0,
                    by - height as f64 / 2.0
                ),
                format!(
                    "{}+{grid}*({}*sin({theta})+{}*cos({theta}))",
                    height as f64 / 2.0,
                    bx - width as f64 / 2.0,
                    by - height as f64 / 2.0
                ),
            )
        } else {
            (format!("{bx}+({offset_x})"), format!("{by}+({offset_y})"))
        };
        filters.push(format!("[{prefix}_base{tile}][{prefix}_tile{tile}]overlay=x='round({cx}-overlay_w/2)':y='round({cy}-overlay_h/2)':eval=frame:format=auto:eof_action=pass:repeatlast=0:enable='{active}'[{prefix}_base{}]", tile+1));
    }
    Some(format!("[{prefix}_base{pieces}]null"))
}

// Filter enable/scale/rotate use t, while geq uses T. Replace only complete
// identifiers, retaining function names such as sqrt and gte verbatim.
fn expression_clock(expression: &str, from: char, to: char) -> String {
    let chars: Vec<_> = expression.chars().collect();
    chars
        .iter()
        .enumerate()
        .map(|(index, &value)| {
            let identifier = |c: char| c.is_ascii_alphanumeric() || c == '_';
            if value == from
                && (index == 0 || !identifier(chars[index - 1]))
                && (index + 1 == chars.len() || !identifier(chars[index + 1]))
            {
                to
            } else {
                value
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::expression_clock;
    use crate::clip_animation::Easing;
    #[test]
    fn frame_clocks_preserve_functions_and_all_easing_at_nonzero_time() {
        for easing in [
            Easing::Linear,
            Easing::EaseIn,
            Easing::EaseOut,
            Easing::EaseInOut,
            Easing::Step,
        ] {
            let visibility = easing.expression("clip((T-18.6)/0.4,0,1)");
            let alpha = format!("sqrt({visibility})");
            assert_eq!(
                expression_clock(&expression_clock(&alpha, 'T', 't'), 't', 'T'),
                alpha
            );
        }
        assert_eq!(
            expression_clock("sqrt(t)+gte(t,2)+tanh(t)+time", 't', 'T'),
            "sqrt(T)+gte(T,2)+tanh(T)+time"
        );
    }
}
