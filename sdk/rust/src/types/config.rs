use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Parameters for config.get.
#[derive(Debug, Clone, Serialize, Default)]
pub struct ConfigGetParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
}

/// Parameters for config.set.
#[derive(Debug, Clone, Serialize)]
pub struct ConfigSetParams {
    pub key: String,
    pub value: serde_json::Value,
}

/// Parameters for config.apply.
#[derive(Debug, Clone, Serialize, Default)]
pub struct ConfigApplyParams {
    pub config: serde_json::Value,
}

/// Parameters for config.patch.
#[derive(Debug, Clone, Serialize, Default)]
pub struct ConfigPatchParams {
    pub patches: Vec<serde_json::Value>,
}

/// Parameters for config.schema.
#[derive(Debug, Clone, Serialize, Default)]
pub struct ConfigSchemaParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
}

/// Config schema response.
#[derive(Debug, Clone, Deserialize)]
pub struct ConfigSchemaResponse {
    #[serde(default)]
    pub schema: Option<serde_json::Value>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}
