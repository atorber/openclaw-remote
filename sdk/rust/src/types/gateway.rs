use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Gateway health response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewayHealth {
    pub status: String,
    #[serde(default)]
    pub uptime_seconds: Option<u64>,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub channels: Option<serde_json::Value>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

/// Gateway status response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewayStatus {
    #[serde(default)]
    pub status: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

/// Presence entry from the Gateway.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PresenceEntry {
    #[serde(default)]
    pub channel: Option<String>,
    #[serde(default)]
    pub account: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}
