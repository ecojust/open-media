//! Application-wide model access. Existing providers keep their installed paths
//! and own task state; the facade supplies a common catalog and device budget.
use crate::{
    ai_download::DownloadEstimates,
    ai_execution::AiExecutionGate,
    ai_generation::AiGenerationManager,
    ai_types::{AiJob, AiModel, AiRequest, AiRuntimeStatus, AiStatus, AiVoice},
    engine::{MediaStore, Result, Runtime},
    speech::{SpeechManager, SpeechStatus},
    audio_tools_asr::AsrManager,
    video_generation::{VideoGenerationJob, VideoGenerationManager, VideoGenerationStatus},
};
use std::{collections::HashMap, path::Path, sync::{Arc, Mutex}, time::Instant};

#[derive(Clone)]
pub struct AiService {
    pub(crate) speech: SpeechManager,
    pub(crate) video: VideoGenerationManager,
    pub(crate) asr: AsrManager,
    generation: AiGenerationManager,
    gate: AiExecutionGate,
    downloads: Arc<Mutex<DownloadEstimates>>,
}

impl AiService {
    pub fn new(app_data: &Path, resource: &Path) -> Result<Self> {
        let gate = AiExecutionGate::default();
        Ok(Self {
            speech: SpeechManager::with_gate(app_data, resource, gate.clone())?,
            video: VideoGenerationManager::with_gate(app_data, gate.clone())?,
            asr: AsrManager::new(app_data, Some(resource))?,
            generation: AiGenerationManager::new(app_data, resource, gate.clone())?,
            gate,
            downloads: Arc::new(Mutex::new(DownloadEstimates::default())),
        })
    }
    fn models(&self, probe_runtime: bool) -> Result<Vec<AiModel>> {
        let mut models = speech_models(self.speech.status());
        models.extend(video_models(self.video.status_with_probe(probe_runtime)));
        models.extend(self.generation.models(probe_runtime)?);
        models.extend(self.asr.ai_models());
        Ok(models)
    }
    pub fn status(&self, probe_runtime: bool) -> Result<AiStatus> {
        let mut models = self.models(probe_runtime)?;
        if let Ok(mut downloads) = self.downloads.lock() { downloads.decorate(&mut models, Instant::now()); }
        let mut jobs = self.speech.ai_jobs()?;
        jobs.extend(self.video.list()?.into_iter().map(video_job));
        jobs.extend(self.generation.list()?);
        jobs.extend(self.asr.ai_jobs()?);
        jobs.sort_by(|left, right| right.started_at.cmp(&left.started_at));
        let busy = jobs
            .iter()
            .any(|job| job.cancelable || job.state == "running")
            || models
                .iter()
                .any(|model| matches!(model.state.as_str(), "downloading" | "verifying"));
        Ok(AiStatus { models, jobs, busy })
    }
    fn provider(&self, model_id: &str) -> Result<String> {
        self.models(false)?
            .into_iter()
            .find(|model| model.id == model_id)
            .map(|model| model.provider)
            .ok_or_else(|| "模型不在本机模型目录中。".into())
    }
    pub fn download(&self, model_id: &str, accepted_license: bool) -> Result<AiStatus> {
        match self.provider(model_id)?.as_str() {
            "speech" => {
                let target = speech_download_target(&self.speech.status(), model_id, false)?;
                self.speech.begin_model_download(&target)?;
            }
            "video" => {
                self.video.begin_download(model_id, accepted_license)?;
            }
            "transcription" => { self.asr.begin_download(Some(model_id))?; }
            _ => self.generation.download(model_id, accepted_license)?,
        }
        self.status(false)
    }
    pub fn cancel_download(&self, model_id: &str) -> Result<AiStatus> {
        match self.provider(model_id)?.as_str() {
            "speech" => {
                let target = speech_download_target(&self.speech.status(), model_id, false)?;
                self.speech.cancel_model_download(&target)?;
            }
            "video" => {
                self.video.cancel_download(model_id)?;
            }
            "transcription" => { self.asr.cancel_download(model_id)?; }
            _ => self.generation.cancel_download(model_id)?,
        }
        self.status(false)
    }
    pub fn repair(&self, model_id: &str, accepted_license: bool) -> Result<AiStatus> {
        match self.provider(model_id)?.as_str() {
            "speech" => {
                let target = speech_download_target(&self.speech.status(), model_id, true)?;
                self.speech.repair_model(&target)?;
            }
            "video" => {
                self.video.begin_download(model_id, accepted_license)?;
            }
            "transcription" => { self.asr.begin_download(Some(model_id))?; }
            _ => self.generation.repair(model_id, accepted_license)?,
        }
        self.status(false)
    }
    pub fn begin(&self, runtime: Runtime, store: MediaStore, request: AiRequest) -> Result<AiJob> {
        match request {
            AiRequest::Speech(request) => {
                let job = self.speech.begin(runtime, store, request)?;
                self.get(&format!("speech:{}", job.id))
            }
            AiRequest::Video(request) => self.video.begin(runtime, store, request).map(video_job),
            AiRequest::Image(request) => {
                if self.provider(&request.model_id)? != "image" {
                    return Err("所选模型不支持图片生成。".into());
                }
                self.generation.begin(runtime, store, request)
            }
            AiRequest::Music(request) => {
                if self.provider(&request.model_id)? != "music" {
                    return Err("所选模型不支持歌曲生成。".into());
                }
                self.generation.begin(runtime, store, request)
            }
        }
    }
    pub fn get(&self, id: &str) -> Result<AiJob> {
        if id.starts_with("speech:") {
            return self
                .speech
                .ai_jobs()?
                .into_iter()
                .find(|job| job.id == id)
                .ok_or_else(|| "语音任务不存在。".into());
        }
        if let Some(id) = id.strip_prefix("video:") {
            return self.video.get(id).map(video_job);
        }
        if id.starts_with("transcription:") {
            return self.asr.ai_jobs()?.into_iter().find(|job| job.id == id).ok_or_else(|| "识别任务不存在。".into());
        }
        self.generation.get(id)
    }
    pub fn cancel(&self, id: &str) -> Result<()> {
        if let Some(id) = id.strip_prefix("speech:") {
            return self.speech.cancel(id);
        }
        if let Some(id) = id.strip_prefix("video:") {
            return self.video.cancel(id);
        }
        if let Some(id) = id.strip_prefix("transcription:") { return self.asr.cancel(id); }
        self.generation.cancel(id)
    }
    pub fn shutdown(&self) {
        self.gate.shutdown();
        self.generation.shutdown();
        self.video.shutdown();
        self.speech.shutdown();
        self.asr.shutdown();
    }
}

fn speech_download_target(status: &SpeechStatus, id: &str, repair: bool) -> Result<String> {
    let voice = status
        .voices
        .iter()
        .find(|voice| voice.model_id.as_deref().unwrap_or("bundled") == id)
        .ok_or("配音模型不存在。")?;
    // Some already installed voices offer a separate shared GPU runtime. Keep
    // the catalog model ID stable while targeting that runtime's existing store.
    if !repair || id == "bundled" {
        if let Some(runtime) = &voice.runtime_download_id {
            return Ok(runtime.clone());
        }
    }
    if id == "bundled" {
        return Err("内置语音资源随应用安装；请重新安装应用修复。".into());
    }
    Ok(id.into())
}

fn speech_models(status: SpeechStatus) -> Vec<AiModel> {
    let catalog: serde_json::Value =
        serde_json::from_str(include_str!("../resources/speech-models.json")).unwrap_or_default();
    let versions: HashMap<String, String> = catalog["models"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|value| {
            Some((
                value["id"].as_str()?.to_owned(),
                value["version"].as_u64()?.to_string(),
            ))
        })
        .collect();
    let mut models: Vec<AiModel> = Vec::new();
    for voice in status.voices {
        let id = voice.model_id.clone().unwrap_or_else(|| "bundled".into());
        let item = AiVoice {
            id: voice.id.clone(),
            name: voice.name.clone(),
            language: voice.language.clone(),
            gender: voice.gender.clone(),
        };
        if let Some(model) = models.iter_mut().find(|model| model.id == id) {
            model.voices.push(item);
            continue;
        }
        let bundled = id == "bundled";
        let raw_state = voice.status.as_deref().unwrap_or("not-downloaded");
        let runtime_state = voice.runtime_status.clone().unwrap_or_else(|| {
            if matches!(raw_state, "ready" | "bundled") {
                "ready"
            } else {
                "not-installed"
            }
            .into()
        });
        let state = if runtime_state.starts_with("upgrade-") {
            match runtime_state.as_str() {
                "upgrade-downloading" => "downloading",
                "upgrade-verifying" => "verifying",
                _ => "update-available",
            }
        } else if bundled {
            "ready"
        } else {
            raw_state
        };
        let (name, memory) = match id.as_str() {
            "bundled" => ("Matcha 中英", 4),
            "zipvoice-distill-fp32" => ("ZipVoice Distill FP32", 8),
            "f5-v1-base-fp32" => ("F5-TTS v1 Base FP32", 8),
            "qwen3-tts-1.7b-serena" => ("Qwen3-TTS 1.7B BF16", 16),
            _ => (voice.name.as_str(), 8),
        };
        let separate_runtime = voice
            .runtime_download_id
            .as_ref()
            .is_some_and(|runtime| runtime != &id);
        let size = if separate_runtime {
            voice
                .model_size
                .unwrap_or(0)
                .saturating_add(voice.runtime_size.unwrap_or(0))
        } else if bundled {
            voice.model_size.unwrap_or(0)
        } else {
            voice.download_size.or(voice.model_size).unwrap_or(0)
        };
        models.push(AiModel {
            id: id.clone(),
            name: name.into(),
            provider: "speech".into(),
            capabilities: vec!["text-to-speech".into()],
            version: versions
                .get(&id)
                .cloned()
                .unwrap_or_else(|| "bundled".into()),
            size,
            downloaded_bytes: if separate_runtime {
                voice
                    .model_size
                    .unwrap_or(0)
                    .saturating_add(voice.downloaded_bytes.unwrap_or(0))
                    .min(size)
            } else if bundled {
                size
            } else {
                voice.downloaded_bytes.unwrap_or(0).min(size)
            },
            download_total_bytes: None,
            download_transferred_bytes: None,
            download_phase: None,
            active_source: voice.download_source.clone(),
            download_session: voice.download_session,
            download_speed_bytes_per_second: None,
            remaining_seconds: None,
            state: state.into(),
            hardware: format!("建议 {memory} GB 系统内存；优先可用 GPU，失败时回退 CPU。"),
            runtime: AiRuntimeStatus {
                state: runtime_state,
                device: None,
                reason: voice.runtime_error,
            },
            bundled,
            requires_license_acceptance: false,
            license: voice.license,
            license_url: None,
            error: voice.error,
            voices: vec![item],
        });
    }
    models
}
fn video_models(status: VideoGenerationStatus) -> Vec<AiModel> {
    let runtime = AiRuntimeStatus {
        state: if !status.supported {
            "unsupported"
        } else if status.runtime_ready {
            "ready"
        } else if status.reason.is_some() {
            "failed"
        } else {
            "not-checked"
        }
        .into(),
        device: (!status.device.is_empty()).then_some(status.device),
        reason: status.reason,
    };
    status
        .models
        .into_iter()
        .map(|model| AiModel {
            id: model.id,
            name: model.name,
            provider: "video".into(),
            version: model.version,
            size: model.size,
            downloaded_bytes: model.downloaded_bytes,
            download_total_bytes: None,
            download_transferred_bytes: None,
            download_phase: None,
            active_source: model.active_source,
            download_session: model.download_session,
            download_speed_bytes_per_second: None,
            remaining_seconds: None,
            state: model.state,
            hardware: model.hardware,
            runtime: runtime.clone(),
            capabilities: model
                .modes
                .into_iter()
                .filter_map(|mode| match mode.as_str() {
                    "prompt" => Some("text-to-video"),
                    "image" => Some("image-to-video"),
                    "reference" => Some("reference-to-video"),
                    "storyboard" => Some("storyboard-to-video"),
                    _ => None,
                })
                .map(String::from)
                .collect(),
            bundled: false,
            requires_license_acceptance: true,
            license: Some("MiniMax H3 Community License".into()),
            license_url: Some(model.license_url),
            error: model.error,
            voices: vec![],
        })
        .collect()
}
fn video_job(job: VideoGenerationJob) -> AiJob {
    let mut assets = job.assets;
    if let Some(combined) = job.combined_asset {
        assets.insert(0, combined);
    }
    AiJob {
        id: format!("video:{}", job.id),
        provider: "video".into(),
        model_id: job.model_id,
        kind: "generation".into(),
        cancelable: job.state == "running",
        state: job.state,
        stage: job.stage,
        progress: job.progress,
        started_at: job.started_at,
        elapsed_seconds: job.elapsed_seconds,
        assets,
        error: job.error,
        warning: job.warning,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn voices_share_one_download_and_runtime_updates_remain_visible() {
        let voices = ["female", "male"].into_iter().map(|gender| serde_json::from_value(json!({
            "id":format!("f5_{gender}"),"name":format!("声音 {gender}"),"language":"zh-CN","gender":gender,"speakerId":0,
            "modelId":"f5-v1-base-fp32","modelSize":100,"downloadSize":140,"downloadedBytes":100,
            "status":"ready","runtimeStatus":"upgrade-available"
        })).unwrap()).collect();
        let models = speech_models(SpeechStatus {
            ready: true,
            voices,
            error: None,
        });
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].voices.len(), 2);
        assert_eq!(models[0].id, "f5-v1-base-fp32");
        assert_eq!(models[0].state, "update-available");
        assert_eq!(models[0].size, 140);
        assert_eq!(models[0].version, "1");
    }

    #[test]
    fn global_generation_never_accepts_caller_supplied_executable() {
        let input = json!({"provider":"image","request":{"requestId":"test","modelId":"model","prompt":"一座山","script":"/tmp/anything.py"}});
        assert!(serde_json::from_value::<AiRequest>(input).is_err());
    }

    #[test]
    fn installed_voice_download_routes_to_its_shared_acceleration_runtime() {
        let voice = serde_json::from_value(json!({
            "id":"matcha_zh_en_female","name":"配音","language":"zh-CN","speakerId":0,
            "modelId":"bundled","status":"bundled","modelSize":100,
            "runtimeDownloadId":"native-gpu","runtimeStatus":"upgrade-downloading",
            "runtimeSize":40,"downloadSize":40,"downloadedBytes":20,
            "downloadSource":"https://mirror.example","downloadSession":23
        }))
        .unwrap();
        let status = SpeechStatus {
            ready: true,
            voices: vec![voice],
            error: None,
        };
        assert_eq!(
            speech_download_target(&status, "bundled", false).unwrap(),
            "native-gpu"
        );
        assert_eq!(
            speech_download_target(&status, "bundled", true).unwrap(),
            "native-gpu"
        );
        let models = speech_models(status);
        assert_eq!(models[0].state, "downloading");
        assert_eq!(models[0].size, 140);
        assert_eq!(models[0].downloaded_bytes, 120);
        assert_eq!(models[0].active_source.as_deref(), Some("https://mirror.example"));
        assert_eq!(models[0].download_session, Some(23));
    }

    #[test]
    fn video_download_session_reaches_the_shared_estimator() {
        let model = serde_json::from_value(json!({
            "id":"video","name":"视频模型","version":"1","modes":["prompt"],
            "size":200,"downloadedBytes":40,"state":"downloading","hardware":"测试",
            "licenseUrl":"https://example.org/license","activeSource":"https://mirror.example","downloadSession":31
        })).unwrap();
        let models = video_models(VideoGenerationStatus {
            supported: true, reason: None, runtime_ready: true, runtime_version: "test".into(),
            device: "test".into(), memory_bytes: None, models: vec![model],
        });
        assert_eq!(models[0].active_source.as_deref(), Some("https://mirror.example"));
        assert_eq!(models[0].download_session, Some(31));
        assert_eq!(models[0].downloaded_bytes, 40);
    }
}
