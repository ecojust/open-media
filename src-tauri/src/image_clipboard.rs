use crate::engine::Result;

const MAX_CLIPBOARD_PIXELS: usize = 40_000_000;

pub fn require_main_window(label: &str) -> Result<()> {
    if label == "main" {
        Ok(())
    } else {
        Err("只有主窗口可以复制图片。".into())
    }
}

pub fn validate_image(width: u32, height: u32, rgba_len: usize) -> Result<(usize, usize)> {
    if width == 0 || height == 0 {
        return Err("图片宽高必须为正整数。".into());
    }
    if width > MAX_CLIPBOARD_PIXELS as u32 || height > MAX_CLIPBOARD_PIXELS as u32 {
        return Err("复制的图片不能超过 4000 万像素，请先缩小图片。".into());
    }
    let width = width as usize;
    let height = height as usize;
    let pixels = width
        .checked_mul(height)
        .filter(|pixels| *pixels <= MAX_CLIPBOARD_PIXELS)
        .ok_or("复制的图片不能超过 4000 万像素，请先缩小图片。")?;
    let expected_len = pixels.checked_mul(4).ok_or("图片像素数据过大。")?;
    if rgba_len != expected_len {
        return Err("图片像素数据不完整，请重新打开图片后复制。".into());
    }
    Ok((width, height))
}

pub fn validate_packet(bytes: &[u8]) -> Result<(usize, usize)> {
    let header = bytes.get(..8).ok_or("图片像素数据缺少尺寸信息。")?;
    let width = u32::from_le_bytes([header[0], header[1], header[2], header[3]]);
    let height = u32::from_le_bytes([header[4], header[5], header[6], header[7]]);
    validate_image(width, height, bytes.len() - 8)
}

#[cfg(feature = "desktop")]
#[derive(Clone, Default)]
pub struct ImageClipboard {
    // Keep the clipboard owner alive so systems serving images from this process
    // can still answer paste requests after the command has returned.
    clipboard: std::sync::Arc<std::sync::Mutex<Option<arboard::Clipboard>>>,
}

#[cfg(feature = "desktop")]
impl ImageClipboard {
    pub fn copy(&self, mut packet: Vec<u8>) -> Result<()> {
        let (width, height) = validate_packet(&packet)?;
        packet.drain(..8);
        let mut state = self
            .clipboard
            .lock()
            .map_err(|_| "图片剪贴板状态不可用，请重试。")?;
        if state.is_none() {
            *state = Some(
                arboard::Clipboard::new()
                    .map_err(|error| format!("无法访问系统剪贴板：{error}"))?,
            );
        }
        let clipboard = state.as_mut().ok_or("无法访问系统剪贴板。")?;
        clipboard
            .set_image(arboard::ImageData {
                width,
                height,
                bytes: std::borrow::Cow::Owned(packet),
            })
            .map_err(|error| format!("图片复制失败，请重试：{error}"))
    }

    pub fn shutdown(&self) {
        if let Ok(mut state) = self.clipboard.lock() {
            state.take();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_main_window_can_replace_the_clipboard() {
        assert!(require_main_window("main").is_ok());
        for label in ["", "capture-picker", "recording-controls", "Main"] {
            assert!(require_main_window(label).is_err());
        }
    }

    #[test]
    fn validates_pixel_dimensions_and_exact_rgba_length() {
        assert_eq!(validate_image(2, 3, 24).unwrap(), (2, 3));
        assert_eq!(validate_image(1, 1, 4).unwrap(), (1, 1));
        for length in [0, 23, 25] {
            assert!(validate_image(2, 3, length).is_err());
        }
        assert!(validate_image(0, 1, 0).is_err());
        assert!(validate_image(1, 0, 0).is_err());
    }

    #[test]
    fn binary_packet_keeps_dimensions_and_pixels_unambiguous() {
        let mut packet = Vec::new();
        packet.extend_from_slice(&2_u32.to_le_bytes());
        packet.extend_from_slice(&1_u32.to_le_bytes());
        packet.extend_from_slice(&[255, 0, 0, 255, 0, 255, 0, 128]);
        assert_eq!(validate_packet(&packet).unwrap(), (2, 1));
        for length in 0..packet.len() {
            assert!(validate_packet(&packet[..length]).is_err());
        }
        packet.push(0);
        assert!(validate_packet(&packet).is_err());
    }

    #[test]
    fn caps_image_memory_before_accessing_pixels() {
        for (width, height) in [(6016, 3384), (7680, 4320)] {
            assert_eq!(
                validate_image(width, height, width as usize * height as usize * 4).unwrap(),
                (width as usize, height as usize)
            );
        }
        assert_eq!(
            validate_image(8000, 5000, MAX_CLIPBOARD_PIXELS * 4).unwrap(),
            (8000, 5000)
        );
        assert!(validate_image(8001, 5000, 8001 * 5000 * 4).is_err());
        assert!(validate_image(MAX_CLIPBOARD_PIXELS as u32 + 1, 1, 0).is_err());
        assert!(validate_image(u32::MAX, u32::MAX, 0).is_err());
        assert!(validate_image(40_000_000, 40_000_000, 0).is_err());
    }
}
