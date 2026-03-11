use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Parameters for running an agent turn.
#[derive(Debug, Clone, Serialize, Default)]
pub struct AgentRunParams {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "sessionId")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deliver: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "replyChannel")]
    pub reply_channel: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "replyTo")]
    pub reply_to: Option<String>,
}

/// Parameters for waiting on an agent turn.
#[derive(Debug, Clone, Serialize, Default)]
pub struct AgentWaitParams {
    #[serde(skip_serializing_if = "Option::is_none", rename = "sessionId")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout: Option<u64>,
}

/// Result from an agent turn.
#[derive(Debug, Clone, Deserialize)]
pub struct AgentTurnResult {
    #[serde(default)]
    pub reply: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}
