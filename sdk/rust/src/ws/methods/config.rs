use crate::error::SdkError;
use crate::types::config::{
    ConfigApplyParams, ConfigGetParams, ConfigPatchParams, ConfigSchemaParams,
    ConfigSchemaResponse, ConfigSetParams,
};
use crate::ws::traits::GatewayRpc;

/// Configuration RPC methods.
pub struct ConfigMethods<'a, G: GatewayRpc> {
    pub(crate) rpc: &'a G,
}

impl<'a, G: GatewayRpc> ConfigMethods<'a, G> {
    /// Create a new ConfigMethods instance.
    pub fn new(rpc: &'a G) -> Self {
        Self { rpc }
    }

    /// Get configuration value(s).
    pub async fn get(&self, params: ConfigGetParams) -> Result<serde_json::Value, SdkError> {
        self.rpc.request("config.get", params).await
    }

    /// Set a configuration value.
    pub async fn set(&self, params: ConfigSetParams) -> Result<serde_json::Value, SdkError> {
        self.rpc.request("config.set", params).await
    }

    /// Apply a full configuration object.
    pub async fn apply(&self, params: ConfigApplyParams) -> Result<serde_json::Value, SdkError> {
        self.rpc.request("config.apply", params).await
    }

    /// Apply incremental patches.
    pub async fn patch(&self, params: ConfigPatchParams) -> Result<serde_json::Value, SdkError> {
        self.rpc.request("config.patch", params).await
    }

    /// Get the configuration schema.
    pub async fn schema(
        &self,
        params: ConfigSchemaParams,
    ) -> Result<ConfigSchemaResponse, SdkError> {
        self.rpc.request("config.schema", params).await
    }
}
