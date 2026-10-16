use crate::engine::Result;
use serde::Deserialize;
use serde_json::Value;

type ColorMatrix = [[f64; 4]; 3];

const IDENTITY: ColorMatrix = [
    [1.0, 0.0, 0.0, 0.0],
    [0.0, 1.0, 0.0, 0.0],
    [0.0, 0.0, 1.0, 0.0],
];

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClipFilters {
    enabled: bool,
    intensity: f64,
    brightness: f64,
    contrast: f64,
    saturation: f64,
    temperature: f64,
    tint: f64,
    sepia: f64,
}

impl ClipFilters {
    fn validate(&self) -> Result<()> {
        for (name, value, min, max) in [
            ("intensity", self.intensity, 0.0, 1.0),
            ("brightness", self.brightness, -1.0, 1.0),
            ("contrast", self.contrast, 0.0, 2.0),
            ("saturation", self.saturation, 0.0, 2.0),
            ("temperature", self.temperature, -1.0, 1.0),
            ("tint", self.tint, -1.0, 1.0),
            ("sepia", self.sepia, 0.0, 1.0),
        ] {
            if !value.is_finite() || value < min || value > max {
                return Err(format!("片段滤镜参数 {name} 必须介于 {min} 和 {max} 之间。"));
            }
        }
        Ok(())
    }

    fn matrix(&self) -> ColorMatrix {
        if !self.enabled || self.intensity == 0.0 {
            return IDENTITY;
        }
        let mut matrix = IDENTITY;
        for (row, values) in matrix.iter_mut().enumerate() {
            values[row] = self.contrast;
            values[3] = 0.5 * (1.0 - self.contrast) + self.brightness;
        }
        let luma = [0.2126, 0.7152, 0.0722];
        let mut saturation = IDENTITY;
        for (row, values) in saturation.iter_mut().enumerate() {
            for col in 0..3 {
                values[col] = (1.0 - self.saturation) * luma[col]
                    + if row == col { self.saturation } else { 0.0 };
            }
        }
        matrix = compose(saturation, matrix);
        let sepia_color = [
            [0.393, 0.769, 0.189],
            [0.349, 0.686, 0.168],
            [0.272, 0.534, 0.131],
        ];
        let mut sepia = IDENTITY;
        for (row, values) in sepia.iter_mut().enumerate() {
            for col in 0..3 {
                values[col] = self.sepia * sepia_color[row][col]
                    + if row == col { 1.0 - self.sepia } else { 0.0 };
            }
        }
        matrix = compose(sepia, matrix);
        matrix[0][3] += 0.1 * self.temperature + 0.05 * self.tint;
        matrix[1][3] -= 0.1 * self.tint;
        matrix[2][3] += -0.1 * self.temperature + 0.05 * self.tint;
        for (row, values) in matrix.iter_mut().enumerate() {
            for col in 0..4 {
                values[col] = self.intensity * values[col]
                    + (1.0 - self.intensity) * IDENTITY[row][col];
            }
        }
        matrix
    }
}

fn compose(after: ColorMatrix, before: ColorMatrix) -> ColorMatrix {
    let mut result = [[0.0; 4]; 3];
    for row in 0..3 {
        for col in 0..4 {
            for channel in 0..3 {
                result[row][col] += after[row][channel] * before[channel][col];
            }
            if col == 3 {
                result[row][col] += after[row][3];
            }
        }
    }
    result
}

pub(crate) fn filter_chain(clip: &Value, visual: bool) -> Result<Option<String>> {
    let Some(value) = clip.get("filters") else {
        return Ok(None);
    };
    if !visual {
        return Err("滤镜只能用于视频轨道中的视频或图片片段。".into());
    }
    let filters: ClipFilters = serde_json::from_value(value.clone())
        .map_err(|_| "片段滤镜配置无效，请检查全部参数及其类型。".to_string())?;
    filters.validate()?;
    let matrix = filters.matrix();
    if matrix == IDENTITY {
        return Ok(None);
    }
    // Compose the whole RGB transform first, then clamp once. Sample the exact
    // pixel: bilinear lookup in older engines clamps the final row and column.
    // The caller restores alpha separately so format conversion cannot round it.
    let expression = |row: [f64; 4]| {
        format!(
            "clip(({:.12})*r(X,Y)+({:.12})*g(X,Y)+({:.12})*b(X,Y)+({:.12}),0,255)",
            row[0], row[1], row[2], row[3] * 255.0
        )
    };
    Ok(Some(format!(
        "format=gbrp,geq=interpolation=nearest:r='{}':g='{}':b='{}',format=rgba",
        expression(matrix[0]), expression(matrix[1]), expression(matrix[2])
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn neutral() -> Value {
        json!({"enabled":true,"intensity":1,"brightness":0,"contrast":1,"saturation":1,"temperature":0,"tint":0,"sepia":0})
    }

    #[test]
    fn existing_neutral_and_disabled_clips_do_not_change_the_graph() {
        assert_eq!(filter_chain(&json!({}), true).unwrap(), None);
        assert_eq!(filter_chain(&json!({"filters":neutral()}), true).unwrap(), None);
        let mut filters = neutral();
        filters["enabled"] = json!(false);
        filters["brightness"] = json!(1);
        assert_eq!(filter_chain(&json!({"filters":filters}), true).unwrap(), None);
    }

    #[test]
    fn invalid_or_non_visual_filter_settings_are_rejected() {
        for value in [json!(null), json!(true), json!({}), json!([])] {
            assert!(filter_chain(&json!({"filters":value}), true).is_err());
        }
        for (field, value) in [
            ("enabled", json!(1)),
            ("intensity", json!("0.5")),
            ("contrast", json!(2.1)),
            ("brightness", json!(-1.1)),
            ("saturation", json!(null)),
            ("extra", json!(0)),
        ] {
            let mut filters = neutral();
            filters[field] = value;
            assert!(filter_chain(&json!({"filters":filters}), true).is_err(), "{field}");
        }
        assert!(filter_chain(&json!({"filters":neutral()}), false).is_err());
    }

    #[test]
    fn matrix_uses_final_intensity_and_luma_grayscale() {
        let mut value = neutral();
        value["saturation"] = json!(0);
        let filters: ClipFilters = serde_json::from_value(value.clone()).unwrap();
        for row in filters.matrix() {
            assert_eq!(row, [0.2126, 0.7152, 0.0722, 0.0]);
        }
        value["saturation"] = json!(1);
        value["contrast"] = json!(2);
        value["brightness"] = json!(0.4);
        value["temperature"] = json!(1);
        value["intensity"] = json!(0.5);
        let filters: ClipFilters = serde_json::from_value(value.clone()).unwrap();
        let matrix = filters.matrix();
        assert!((matrix[0][0] - 1.5).abs() < 1e-12);
        assert!(matrix[0][3].abs() < 1e-12);
        assert!((matrix[1][3] + 0.05).abs() < 1e-12);
        assert!((matrix[2][3] + 0.1).abs() < 1e-12);
    }

    #[test]
    fn combined_adjustments_match_preview_matrix_contract() {
        let filters: ClipFilters = serde_json::from_value(json!({
            "enabled":true,"intensity":0.75,"brightness":0.08,"contrast":1.3,
            "saturation":0.65,"temperature":0.4,"tint":-0.2,"sepia":0.3
        })).unwrap();
        let expected = [
            [0.8485333636749999, 0.4159678536, 0.063166282725, -0.03552825000000001],
            [0.14332165477499997, 1.0829761258000001, 0.058079719425, -0.04069725000000002],
            [0.12289255972500002, 0.34097597820000003, 0.742703962075, -0.08900775000000002],
        ];
        for (actual, expected) in filters.matrix().iter().flatten().zip(expected.iter().flatten()) {
            assert!((actual - expected).abs() < 1e-12);
        }
    }
}
