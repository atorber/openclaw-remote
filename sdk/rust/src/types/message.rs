use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Parameters for sending a message.
#[derive(Debug, Clone, Serialize, Default)]
pub struct SendParams {
    pub target: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub media: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "replyTo")]
    pub reply_to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "threadId")]
    pub thread_id: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub deliver: bool,
}

/// Result from sending a message.
#[derive(Debug, Clone, Deserialize)]
pub struct SendResult {
    #[serde(default)]
    pub ok: Option<bool>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}
