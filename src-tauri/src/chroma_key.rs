use crate::engine::Result;
use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChromaKey {
    enabled: bool,
    color: String,
    similarity: f64,
    blend: f64,
}

pub(crate) fn filter_chain(clip: &Value, visual: bool) -> Result<Option<String>> {
    let Some(value) = clip.get("chromaKey") else {
        return Ok(None);
    };
    if !visual {
        return Err("色度抠像只能用于视频轨道中的视频或图片片段。".into());
    }
    let key: ChromaKey = serde_json::from_value(value.clone())
        .map_err(|_| "片段抠像配置无效，请检查全部参数及其类型。".to_string())?;
    if key.color.len() != 7
        || !key.color.starts_with('#')
        || !key.color.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
    {
        return Err("抠像颜色必须为完整的六位十六进制颜色。".into());
    }
    for (name, value, min, max) in [
        ("similarity", key.similarity, 0.01, 1.0),
        ("blend", key.blend, 0.0, 1.0),
    ] {
        if !value.is_finite() || value < min || value > max {
            return Err(format!("片段抠像参数 {name} 必须介于 {min} 和 {max} 之间。"));
        }
    }
    if !key.enabled {
        return Ok(None);
    }
    // RGB distance is sqrt((dr² + dg² + db²) / 3) / 255, shared with preview.
    Ok(Some(format!(
        "colorkey=color=0x{}:similarity={:.12}:blend={:.12}",
        &key.color[1..], key.similarity, key.blend
    )))
}

pub(crate) fn append_graph(
    chain: String,
    graph: &mut Vec<String>,
    index: usize,
    filter: &str,
) -> String {
    // The key filter replaces alpha. Multiply its mask with the original alpha
    // before scaling so transparent edges and translucent artwork stay intact.
    graph.push(format!("{chain},split[key_input{index}][key_original{index}]"));
    graph.push(format!("[key_original{index}]alphaextract[key_original_mask{index}]"));
    graph.push(format!("[key_input{index}]{filter},split[key_color{index}][key_alpha{index}]"));
    graph.push(format!("[key_alpha{index}]alphaextract[key_mask{index}]"));
    graph.push(format!("[key_original_mask{index}][key_mask{index}]blend=all_expr='A*B/255'[key_combined{index}]"));
    format!("[key_color{index}][key_combined{index}]alphamerge")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn enabled() -> Value {
        json!({"enabled":true,"color":"#00ff00","similarity":0.18,"blend":0.08})
    }

    #[test]
    fn optional_and_disabled_keys_preserve_existing_clips() {
        assert_eq!(filter_chain(&json!({}), true).unwrap(), None);
        let mut key = enabled();
        key["enabled"] = json!(false);
        assert_eq!(filter_chain(&json!({"chromaKey":key}), true).unwrap(), None);
        assert_eq!(
            filter_chain(&json!({"chromaKey":enabled()}), true).unwrap().unwrap(),
            "colorkey=color=0x00ff00:similarity=0.180000000000:blend=0.080000000000"
        );
    }

    #[test]
    fn malformed_and_non_visual_keys_are_rejected_even_when_disabled() {
        for value in [json!(null), json!(true), json!({}), json!([])] {
            assert!(filter_chain(&json!({"chromaKey":value}), true).is_err());
        }
        for (field, value) in [
            ("enabled", json!(1)),
            ("similarity", json!("0.18")),
            ("similarity", json!(0)),
            ("similarity", json!(1.01)),
            ("blend", json!(-0.1)),
            ("blend", json!(1.01)),
            ("color", json!("#0f0")),
            ("color", json!("#00gg00")),
            ("color", json!("#00ff00,split")),
            ("color", json!(null)),
            ("extra", json!(0)),
        ] {
            let mut key = enabled();
            key["enabled"] = json!(false);
            key[field] = value;
            assert!(filter_chain(&json!({"chromaKey":key}), true).is_err(), "{field}");
        }
        assert!(filter_chain(&json!({"chromaKey":enabled()}), false).is_err());
    }
}
