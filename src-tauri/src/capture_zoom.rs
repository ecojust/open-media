//! Pointer-anchored recording crop, measured inside the original selection.
use super::CaptureBounds;

#[derive(Clone, Debug)]
pub struct ZoomViewport {
    pub original: CaptureBounds,
    x: f64,
    y: f64,
    scale: f64,
}
impl ZoomViewport {
    pub fn new(original: CaptureBounds) -> Self {
        Self {
            original,
            x: 0.0,
            y: 0.0,
            scale: 1.0,
        }
    }
    pub fn restore(&mut self, value: &serde_json::Value) {
        let Some((x, y, w, h)) = value["x"]
            .as_f64()
            .zip(value["y"].as_f64())
            .zip(value["width"].as_f64().zip(value["height"].as_f64()))
            .map(|((x, y), (w, h))| (x, y, w, h))
        else {
            return;
        };
        if ![x, y, w, h].iter().all(|n| n.is_finite())
            || x < 0.0
            || y < 0.0
            || w < 0.125
            || h < 0.125
            || w > 1.0
            || h > 1.0
            || (w - h).abs() > 0.001
            || x + w > 1.000001
            || y + h > 1.000001
        {
            return;
        }
        self.scale = (1.0 / w).min(self.max_scale());
        self.x = (x * f64::from(self.original.width)).clamp(
            0.0,
            f64::from(self.original.width) * (1.0 - 1.0 / self.scale),
        );
        self.y = (y * f64::from(self.original.height)).clamp(
            0.0,
            f64::from(self.original.height) * (1.0 - 1.0 / self.scale),
        );
    }
    pub fn snapshot(&self) -> serde_json::Value {
        serde_json::json!({"x":self.x/f64::from(self.original.width), "y":self.y/f64::from(self.original.height), "width":1.0/self.scale, "height":1.0/self.scale})
    }
    fn max_scale(&self) -> f64 {
        8.0_f64
            .min(f64::from(self.original.width.min(self.original.height)) / 16.0)
            .max(1.0)
    }
    pub fn wheel(&mut self, mouse_x: f64, mouse_y: f64, steps: f64) -> bool {
        if ![mouse_x, mouse_y, steps].iter().all(|n| n.is_finite()) || steps == 0.0 {
            return false;
        }
        let px = mouse_x - f64::from(self.original.x);
        let py = mouse_y - f64::from(self.original.y);
        if px < 0.0
            || py < 0.0
            || px >= f64::from(self.original.width)
            || py >= f64::from(self.original.height)
        {
            return false;
        }
        let old_w = f64::from(self.original.width) / self.scale;
        let old_h = f64::from(self.original.height) / self.scale;
        let anchor_x = px.clamp(self.x, self.x + old_w);
        let anchor_y = py.clamp(self.y, self.y + old_h);
        let scale =
            (self.scale * 1.15_f64.powf(steps.clamp(-32.0, 32.0))).clamp(1.0, self.max_scale());
        let width = f64::from(self.original.width) / scale;
        let height = f64::from(self.original.height) / scale;
        self.x = (anchor_x - (anchor_x - self.x) / old_w * width)
            .clamp(0.0, f64::from(self.original.width) - width);
        self.y = (anchor_y - (anchor_y - self.y) / old_h * height)
            .clamp(0.0, f64::from(self.original.height) - height);
        self.scale = scale;
        true
    }
    pub fn local(&self) -> CaptureBounds {
        let width = (f64::from(self.original.width) / self.scale).round() as u32;
        let height = (f64::from(self.original.height) / self.scale).round() as u32;
        CaptureBounds {
            x: (self.x.round() as i32).clamp(0, (self.original.width - width) as i32),
            y: (self.y.round() as i32).clamp(0, (self.original.height - height) as i32),
            width,
            height,
        }
    }
    pub fn absolute(&self) -> CaptureBounds {
        let mut rect = self.local();
        rect.x += self.original.x;
        rect.y += self.original.y;
        rect
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn viewport() -> ZoomViewport {
        ZoomViewport::new(CaptureBounds {
            x: -1600,
            y: 120,
            width: 1200,
            height: 800,
        })
    }
    #[test]
    fn pointer_anchor_and_original_limit_survive_repeated_zoom() {
        let mut view = viewport();
        let (px, py) = (-1300.0, 320.0);
        assert!(view.wheel(px, py, 1.0));
        let r = view.absolute();
        assert!(((px - f64::from(r.x)) / f64::from(r.width) - 0.25).abs() < 0.002);
        assert!(((py - f64::from(r.y)) / f64::from(r.height) - 0.25).abs() < 0.002);
        for i in 0..200 {
            assert!(view.wheel(
                -1599.0 + f64::from(i % 1199),
                121.0 + f64::from(i % 799),
                1.0
            ));
            let r = view.local();
            assert!(
                r.x >= 0
                    && r.y >= 0
                    && r.x as u32 + r.width <= 1200
                    && r.y as u32 + r.height <= 800
            );
        }
        assert_eq!(view.local().width, 150);
        for _ in 0..100 {
            view.wheel(-401.0, 919.0, -1.0);
        }
        assert_eq!(view.absolute(), view.original);
    }
    #[test]
    fn outside_wheel_and_invalid_saved_state_leave_viewport_unchanged() {
        let mut view = viewport();
        let initial = view.snapshot();
        assert!(!view.wheel(0.0, 0.0, 1.0));
        view.restore(&serde_json::json!({"x":0.9,"y":0.0,"width":0.5,"height":0.5}));
        assert_eq!(view.snapshot(), initial);
        view.wheel(-1000.0, 500.0, 8.0);
        let saved = view.snapshot();
        let mut restored = viewport();
        restored.restore(&saved);
        assert_eq!(restored.local(), view.local());
    }
}
