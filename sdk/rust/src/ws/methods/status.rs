use crate::error::SdkError;
use crate::types::gateway::{GatewayHealth, GatewayStatus, PresenceEntry};
use crate::ws::traits::GatewayRpc;

/// Status and health RPC methods.
pub struct StatusMethods<'a, G: GatewayRpc> {
    pub(crate) rpc: &'a G,
}

impl<'a, G: GatewayRpc> StatusMethods<'a, G> {
    /// Create a new StatusMethods instance.
    pub fn new(rpc: &'a G) -> Self {
        Self { rpc }
    }

    /// Get Gateway health status.
    pub async fn health(&self) -> Result<GatewayHealth, SdkError> {
        self.rpc.request("health", serde_json::json!({})).await
    }

    /// Get Gateway status summary.
    pub async fn status(&self) -> Result<GatewayStatus, SdkError> {
        self.rpc.request("status", serde_json::json!({})).await
    }

    /// Get system presence entries.
    pub async fn presence(&self) -> Result<Vec<PresenceEntry>, SdkError> {
        self.rpc
            .request("system-presence", serde_json::json!({}))
            .await
    }

    /// Get the last heartbeat data.
    pub async fn last_heartbeat(&self) -> Result<serde_json::Value, SdkError> {
        self.rpc
            .request("last-heartbeat", serde_json::json!({}))
            .await
    }
}
