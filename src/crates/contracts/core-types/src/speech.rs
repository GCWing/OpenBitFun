use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpeechModelInstallState {
    NotInstalled,
    Downloading,
    Installed,
    Verifying,
    Corrupt,
    Deleting,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechModelProgress {
    pub model_id: String,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub percent: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechModelStatus {
    pub model_id: String,
    pub display_name: String,
    pub provider: String,
    pub version: String,
    pub description: String,
    pub languages: Vec<String>,
    pub state: SpeechModelInstallState,
    pub installed_path: Option<PathBuf>,
    pub installed_bytes: u64,
    pub expected_bytes: u64,
    pub progress: Option<SpeechModelProgress>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechListModelsResponse {
    pub models: Vec<SpeechModelStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechDownloadModelRequest {
    pub model_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechCancelModelDownloadRequest {
    pub model_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechDeleteModelRequest {
    pub model_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechVerifyModelRequest {
    pub model_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechModelProgressEvent {
    pub status: SpeechModelStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechStartInputSessionRequest {
    #[serde(default)]
    pub model_id: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub sample_rate: Option<u32>,
    #[serde(default)]
    pub max_recording_seconds: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechInputSession {
    pub session_id: String,
    pub model_id: String,
    pub language: String,
    pub sample_rate: u32,
    pub max_recording_seconds: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechAppendAudioChunkRequest {
    pub session_id: String,
    /// Base64-encoded PCM16 little-endian mono audio.
    pub pcm16_base64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechAppendAudioChunkResponse {
    pub received_bytes: u64,
    pub received_seconds: f64,
    pub limit_reached: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechFinishInputSessionRequest {
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechCancelInputSessionRequest {
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechTranscriptionResult {
    pub text: String,
    pub language: String,
    pub duration_ms: u64,
    pub audio_duration_seconds: f64,
}

/// Request to start a controller-local full-duplex voice conversation.
///
/// Provider credentials and model policy are intentionally not part of this
/// frontend command contract. The Desktop adapter resolves them from the
/// controller's persisted configuration before calling the integration
/// service.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechStartRealtimeSessionRequest {
    /// Compact controller-side context captured when the client-level voice
    /// assistant starts. Older clients omit it; the realtime model can refresh
    /// the snapshot later through its client-context tool.
    #[serde(default)]
    pub client_context: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechGetRealtimeConfigRequest {}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechRealtimeConfig {
    pub enabled: bool,
    pub provider: String,
    pub api_key: String,
    pub voice: String,
    pub speed: i32,
    pub loudness: i32,
    pub microphone_device_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechSaveRealtimeConfigRequest {
    pub enabled: bool,
    pub api_key: String,
    pub voice: String,
    pub speed: i32,
    pub loudness: i32,
    pub microphone_device_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechRealtimeSession {
    pub session_id: String,
    pub input_sample_rate: u32,
    pub output_sample_rate: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechAppendRealtimeAudioRequest {
    pub session_id: String,
    /// Base64-encoded PCM16 little-endian mono audio at 16 kHz.
    pub pcm16_base64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechRealtimeSessionRequest {
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechRealtimeToolResultRequest {
    pub session_id: String,
    pub call_id: String,
    pub result: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechRealtimeSpeakRequest {
    pub session_id: String,
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpeechRealtimeEventKind {
    Connected,
    Ready,
    UserSpeechStarted,
    UserTranscriptDelta,
    UserTranscriptCompleted,
    AssistantTextDelta,
    AssistantTextCompleted,
    /// All output items, including function calls, for this response have settled.
    AssistantResponseCompleted,
    AssistantAudioStarted,
    AssistantAudioDelta,
    AssistantAudioCompleted,
    FunctionCall,
    Closed,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechRealtimeFunctionCall {
    pub call_id: String,
    pub name: String,
    /// Provider-generated JSON arguments. Consumers must validate the decoded
    /// object again before starting any OpenBitFun task.
    pub arguments: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechRealtimeEvent {
    pub session_id: String,
    pub kind: SpeechRealtimeEventKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio_base64: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub function_calls: Vec<SpeechRealtimeFunctionCall>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_code: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::SpeechStartRealtimeSessionRequest;

    #[test]
    fn realtime_start_request_accepts_legacy_empty_payload() {
        let request: SpeechStartRealtimeSessionRequest = serde_json::from_str("{}").unwrap();
        assert_eq!(request.client_context, None);
    }
}
