use serde::Serialize;

use crate::ws::auth::{AuthPayload, DeviceAuthParams};

/// Protocol version supported by this SDK.
pub const PROTOCOL_VERSION: u32 = 3;

/// How long to wait for the `connect.challenge` event before erroring.
pub const CHALLENGE_TIMEOUT_MS: u64 = 750;

/// Client ID used for the connect handshake.
/// Uses "openclaw-control-ui" for P0 compatibility with existing Gateway.
pub const CLIENT_ID: &str = "openclaw-control-ui";

/// Client mode.
pub const CLIENT_MODE: &str = "ui";

/// Default role.
pub const DEFAULT_ROLE: &str = "operator";

/// Default scopes requested.
pub const DEFAULT_SCOPES: &[&str] = &[
    "operator.admin",
    "operator.approvals",
    "operator.pairing",
];

/// Connect request params sent during the WS handshake.
#[derive(Debug, Clone, Serialize)]
pub struct ConnectParams {
    #[serde(rename = "minProtocol")]
    pub min_protocol: u32,
    #[serde(rename = "maxProtocol")]
    pub max_protocol: u32,
    pub client: ClientInfo,
    pub role: String,
    pub scopes: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub caps: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device: Option<DeviceAuthParams>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth: Option<AuthPayload>,
}

/// Client info included in the connect request.
#[derive(Debug, Clone, Serialize)]
pub struct ClientInfo {
    pub id: String,
    pub version: String,
    pub platform: String,
    pub mode: String,
    #[serde(skip_serializing_if = "Option::is_none", rename = "instanceId")]
    pub instance_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "deviceFamily")]
    pub device_family: Option<String>,
}

impl ConnectParams {
    /// Build connect params from the given auth/device configuration.
    pub fn build(
        auth_payload: Option<AuthPayload>,
        device_auth: Option<DeviceAuthParams>,
    ) -> Self {
        Self {
            min_protocol: PROTOCOL_VERSION,
            max_protocol: PROTOCOL_VERSION,
            client: ClientInfo {
                id: CLIENT_ID.into(),
                version: env!("CARGO_PKG_VERSION").into(),
                platform: std::env::consts::OS.into(),
                mode: CLIENT_MODE.into(),
                instance_id: Some(uuid::Uuid::new_v4().to_string()),
                device_family: None,
            },
            role: DEFAULT_ROLE.into(),
            scopes: DEFAULT_SCOPES.iter().map(|s| s.to_string()).collect(),
            caps: vec!["tool-events".into()],
            device: device_auth,
            auth: auth_payload,
        }
    }
}
