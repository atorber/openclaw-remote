use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Parameters for querying channel status.
#[derive(Debug, Clone, Serialize, Default)]
pub struct ChannelsStatusParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub probe: bool,
}

/// Channel status result.
#[derive(Debug, Clone, Deserialize)]
pub struct ChannelsStatusResult {
    #[serde(default)]
    pub channels: Option<serde_json::Value>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

/// Parameters for logging out a channel.
#[derive(Debug, Clone, Serialize, Default)]
pub struct ChannelsLogoutParams {
    pub channel: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
}
