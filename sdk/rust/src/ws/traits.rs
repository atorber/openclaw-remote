use std::pin::Pin;

use async_trait::async_trait;
use serde::de::DeserializeOwned;
use serde::Serialize;
use tokio::sync::broadcast;

use crate::error::SdkError;
use crate::ws::protocol::EventFrame;

/// Trait abstracting the Gateway WebSocket RPC interface.
///
/// This trait enables mock-based unit testing of method wrappers
/// without requiring a real Gateway connection.
#[async_trait]
pub trait GatewayRpc: Send + Sync {
    /// Send an RPC request and return the raw JSON payload.
    async fn request_raw(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, SdkError>;

    /// Send an RPC request and deserialize the response into `T`.
    async fn request<T: DeserializeOwned + Send>(
        &self,
        method: &str,
        params: impl Serialize + Send,
    ) -> Result<T, SdkError> {
        let value = self
            .request_raw(method, serde_json::to_value(params)?)
            .await?;
        Ok(serde_json::from_value(value)?)
    }

    /// Send a fire-and-forget notification (no response expected).
    async fn notify(&self, method: &str, params: impl Serialize + Send) -> Result<(), SdkError>;

    /// Subscribe to all Gateway events.
    fn subscribe_events(&self) -> broadcast::Receiver<EventFrame>;

    /// Subscribe to events matching a specific event name.
    fn subscribe(&self, event_name: &str) -> Pin<Box<dyn futures_util::Stream<Item = EventFrame> + Send>>;

    /// Whether the Gateway connection is currently active.
    fn is_connected(&self) -> bool;
}
