use crate::error::SdkError;
use crate::types::channel::{ChannelsLogoutParams, ChannelsStatusParams, ChannelsStatusResult};
use crate::ws::traits::GatewayRpc;

/// Channel management RPC methods.
pub struct ChannelMethods<'a, G: GatewayRpc> {
    pub(crate) rpc: &'a G,
}

impl<'a, G: GatewayRpc> ChannelMethods<'a, G> {
    /// Create a new ChannelMethods instance.
    pub fn new(rpc: &'a G) -> Self {
        Self { rpc }
    }

    /// Get channel status.
    pub async fn status(
        &self,
        params: ChannelsStatusParams,
    ) -> Result<ChannelsStatusResult, SdkError> {
        self.rpc.request("channels.status", params).await
    }

    /// Logout a channel.
    pub async fn logout(
        &self,
        params: ChannelsLogoutParams,
    ) -> Result<serde_json::Value, SdkError> {
        self.rpc.request("channels.logout", params).await
    }
}
