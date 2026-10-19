use crate::engine::Asset;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRuntimeStatus {
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiVoice {
    pub id: String,
    pub name: String,
    pub language: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gender: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiModel {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub capabilities: Vec<String>,
    pub version: String,
    pub size: u64,
    pub downloaded_bytes: u64,
    pub state: String,
    pub hardware: String,
    pub runtime: AiRuntimeStatus,
    #[serde(default)]
    pub bundled: bool,
    #[serde(default)]
    pub requires_license_acceptance: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub license_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub voices: Vec<AiVoice>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiJob {
    pub id: String,
    pub provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    pub kind: String,
    pub state: String,
    pub stage: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<f64>,
    pub started_at: u64,
    pub elapsed_seconds: f64,
    pub assets: Vec<Asset>,
    pub cancelable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    pub models: Vec<AiModel>,
    pub jobs: Vec<AiJob>,
    pub busy: bool,
}

/// Generation inputs are data only. The installed catalog chooses the engine.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiGenerationRequest {
    pub request_id: String,
    pub model_id: String,
    pub prompt: String,
    pub negative_prompt: Option<String>,
    pub input_asset: Option<Asset>,
    pub strength: Option<f64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub steps: Option<u32>,
    pub guidance: Option<f64>,
    pub seed: Option<u64>,
    pub lyrics: Option<String>,
    pub instrumental: Option<bool>,
    pub seconds: Option<f64>,
    pub bpm: Option<u32>,
    pub language: Option<String>,
    pub key_scale: Option<String>,
    pub low_memory: Option<bool>,
}

#[derive(Deserialize)]
#[serde(tag = "provider", content = "request", rename_all = "lowercase")]
pub enum AiRequest {
    Speech(crate::speech::SpeechRequest),
    Video(crate::video_generation::VideoGenerationRequest),
    Image(AiGenerationRequest),
    Music(AiGenerationRequest),
}
