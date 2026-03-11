use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Parameters for chat.send.
#[derive(Debug, Clone, Serialize, Default)]
pub struct ChatSendParams {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none", rename = "sessionId")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
}

/// Parameters for chat.history.
#[derive(Debug, Clone, Serialize, Default)]
pub struct ChatHistoryParams {
    #[serde(skip_serializing_if = "Option::is_none", rename = "sessionId")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

/// Parameters for chat.abort.
#[derive(Debug, Clone, Serialize, Default)]
pub struct ChatAbortParams {
    #[serde(skip_serializing_if = "Option::is_none", rename = "sessionId")]
    pub session_id: Option<String>,
}

/// A chat message from history.
#[derive(Debug, Clone, Deserialize)]
pub struct ChatMessage {
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}
