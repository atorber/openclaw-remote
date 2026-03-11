use std::collections::HashMap;

use serde::Deserialize;

/// Chat streaming event payload.
#[derive(Debug, Clone, Deserialize)]
pub struct ChatEvent {
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default, rename = "type")]
    pub event_type: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

/// Agent streaming event payload.
#[derive(Debug, Clone, Deserialize)]
pub struct AgentEvent {
    #[serde(default, rename = "type")]
    pub event_type: Option<String>,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

/// Tick event payload.
#[derive(Debug, Clone, Deserialize)]
pub struct TickEvent {
    #[serde(default)]
    pub ts: Option<u64>,
}
