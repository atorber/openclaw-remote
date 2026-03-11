use crate::error::SdkError;
use crate::types::message::{SendParams, SendResult};
use crate::ws::traits::GatewayRpc;

/// Message sending RPC methods.
pub struct MessageMethods<'a, G: GatewayRpc> {
    pub(crate) rpc: &'a G,
}

impl<'a, G: GatewayRpc> MessageMethods<'a, G> {
    /// Create a new MessageMethods instance.
    pub fn new(rpc: &'a G) -> Self {
        Self { rpc }
    }

    /// Send a message to a target contact.
    pub async fn send(&self, params: SendParams) -> Result<SendResult, SdkError> {
        self.rpc.request("send", params).await
    }
}
