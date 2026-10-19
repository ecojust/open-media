//! Download estimates use measured transfer bytes, never model-loading progress.
use crate::ai_types::AiModel;
use std::{collections::HashMap, sync::atomic::{AtomicU64, Ordering}, time::{Duration, Instant}};

const WARMUP: Duration = Duration::from_secs(3);
const STALLED: Duration = Duration::from_secs(15);
static SESSION: AtomicU64 = AtomicU64::new(1);

pub(crate) fn next_session() -> u64 { SESSION.fetch_add(1, Ordering::Relaxed) }

struct Sample {
    bytes: u64,
    total: u64,
    at: Instant,
    began: Instant,
    last_progress: Instant,
    rate: f64,
    increments: u32,
    phase: Option<String>,
    source: Option<String>,
    session: Option<u64>,
}
impl Sample {
    fn new(model: &AiModel, bytes: u64, total: u64, now: Instant) -> Self {
        Self { bytes, total, at: now, began: now, last_progress: now, rate: 0.0, increments: 0,
            phase: model.download_phase.clone(), source: model.active_source.clone(), session: model.download_session }
    }
}

#[derive(Default)]
pub(crate) struct DownloadEstimates { samples: HashMap<String, Sample> }
impl DownloadEstimates {
    pub(crate) fn decorate(&mut self, models: &mut [AiModel], now: Instant) {
        self.samples.retain(|id, _| models.iter().any(|model| format!("{}:{}", model.provider, model.id) == *id && model.state == "downloading"));
        for model in models {
            model.download_speed_bytes_per_second = None;
            model.remaining_seconds = None;
            if !matches!(model.state.as_str(), "downloading" | "verifying") { continue; }
            let total = model.download_total_bytes.unwrap_or(model.size);
            let bytes = model.download_transferred_bytes.unwrap_or(model.downloaded_bytes).min(total);
            model.download_total_bytes = Some(total);
            model.download_transferred_bytes = Some(bytes);
            if model.download_phase.is_none() {
                model.download_phase = Some(if model.state == "verifying" { "verifying" } else { "model" }.into());
            }
            if model.state != "downloading" || model.download_phase.as_deref() == Some("verifying") || total == 0 || bytes >= total { continue; }
            let id = format!("{}:{}", model.provider, model.id);
            let sample = self.samples.entry(id).or_insert_with(|| Sample::new(model, bytes, total, now));
            let stalled = now.saturating_duration_since(sample.last_progress) >= STALLED;
            if sample.total != total || bytes < sample.bytes || sample.phase != model.download_phase
                || sample.source != model.active_source || sample.session != model.download_session
                || now.saturating_duration_since(sample.at) > Duration::from_secs(60)
                || stalled && bytes > sample.bytes {
                *sample = Sample::new(model, bytes, total, now);
                continue;
            }
            let elapsed = now.saturating_duration_since(sample.at).as_secs_f64();
            if bytes > sample.bytes && elapsed >= 0.25 {
                let measured = (bytes - sample.bytes) as f64 / elapsed;
                let weight = 1.0 - (-elapsed / 5.0).exp();
                sample.rate = if sample.increments == 0 { measured } else { sample.rate + weight * (measured - sample.rate) };
                sample.bytes = bytes; sample.at = now; sample.last_progress = now; sample.increments += 1;
            }
            if !stalled && sample.increments >= 2 && now.saturating_duration_since(sample.began) >= WARMUP
                && sample.rate.is_finite() && sample.rate > 0.0 {
                model.download_speed_bytes_per_second = Some(sample.rate);
                model.remaining_seconds = Some(((total - bytes) as f64 / sample.rate).ceil());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn model(bytes: u64) -> AiModel {
        serde_json::from_value(serde_json::json!({"id":"sample","name":"sample","provider":"image","capabilities":[],"version":"1","size":10000,"downloadedBytes":bytes,"state":"downloading","hardware":"test","runtime":{"state":"ready"}})).unwrap()
    }
    fn sampled(tracker: &mut DownloadEstimates, start: Instant, second: u64, mut model: AiModel) -> AiModel {
        tracker.decorate(std::slice::from_mut(&mut model), start + Duration::from_secs(second)); model
    }
    #[test]
    fn download_estimate_warms_up_and_ignores_preexisting_resume_bytes() {
        let start = Instant::now(); let mut tracker = DownloadEstimates::default();
        assert!(sampled(&mut tracker,start,0,model(5000)).remaining_seconds.is_none());
        assert!(sampled(&mut tracker,start,1,model(5100)).remaining_seconds.is_none());
        let current = sampled(&mut tracker,start,3,model(5300));
        assert_eq!(current.download_speed_bytes_per_second,Some(100.0));
        assert_eq!(current.remaining_seconds,Some(47.0));
    }
    #[test]
    fn download_estimate_disappears_on_stall_verification_and_resume() {
        let start=Instant::now(); let mut tracker=DownloadEstimates::default();
        for second in 0..=3 { sampled(&mut tracker,start,second,model(second*100)); }
        assert!(sampled(&mut tracker,start,18,model(300)).remaining_seconds.is_none());
        assert!(sampled(&mut tracker,start,19,model(500)).remaining_seconds.is_none());
        let mut verifying=model(500); verifying.state="verifying".into();
        assert!(sampled(&mut tracker,start,20,verifying).remaining_seconds.is_none());
        assert!(sampled(&mut tracker,start,21,model(700)).remaining_seconds.is_none());
    }
    #[test]
    fn download_estimate_resets_for_source_session_phase_and_byte_rollback() {
        for change in 0..4 {
            let start=Instant::now(); let mut tracker=DownloadEstimates::default();
            for second in 0..=3 { sampled(&mut tracker,start,second,model(second*100)); }
            let mut next=model(400);
            match change { 0=>next.active_source=Some("mirror.example".into()),1=>next.download_session=Some(2),2=>next.download_phase=Some("runtime".into()),_=>next.downloaded_bytes=50 }
            assert!(sampled(&mut tracker,start,4,next).remaining_seconds.is_none());
        }
    }
    #[test]
    fn download_estimate_uses_runtime_plus_weights_transfer_totals() {
        let start=Instant::now(); let mut tracker=DownloadEstimates::default();
        let mut last=None;
        for second in 0..=3 {
            let mut current=model(0); current.download_phase=Some("runtime".into());
            current.download_total_bytes=Some(20000);current.download_transferred_bytes=Some(second*100);
            last=Some(sampled(&mut tracker,start,second,current));
        }
        let current=last.unwrap();assert_eq!(current.downloaded_bytes,0);assert_eq!(current.remaining_seconds,Some(197.0));
        assert_eq!(current.download_transferred_bytes,Some(300));
    }
}
