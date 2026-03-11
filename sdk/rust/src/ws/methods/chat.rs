use std::pin::Pin;

use crate::error::SdkError;
use crate::types::chat::{ChatAbortParams, ChatHistoryParams, ChatSendParams};
use crate::ws::protocol::EventFrame;
use crate::ws::traits::GatewayRpc;

/// WebChat RPC methods.
pub struct ChatMethods<'a, G: GatewayRpc> {
    pub(crate) rpc: &'a G,
}

impl<'a, G: GatewayRpc> ChatMethods<'a, G> {
    /// Create a new ChatMethods instance.
    pub fn new(rpc: &'a G) -> Self {
        Self { rpc }
    }

    /// Send a chat message.
    pub async fn send(&self, params: ChatSendParams) -> Result<serde_json::Value, SdkError> {
        self.rpc.request("chat.send", params).await
    }

    /// Get chat history.
    pub async fn history(
        &self,
        params: ChatHistoryParams,
    ) -> Result<serde_json::Value, SdkError> {
        self.rpc.request("chat.history", params).await
    }

    /// Abort an in-progress chat completion.
    pub async fn abort(&self, params: ChatAbortParams) -> Result<(), SdkError> {
        self.rpc.request("chat.abort", params).await
    }

    /// Subscribe to real-time chat streaming events.
    pub fn stream(&self) -> Pin<Box<dyn futures_util::Stream<Item = EventFrame> + Send>> {
        self.rpc.subscribe("chat")
    }
}
