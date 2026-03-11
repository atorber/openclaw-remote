//! Mock-based unit tests for WS RPC method wrappers.

use std::pin::Pin;

use async_trait::async_trait;
use tokio::sync::broadcast;

use openclaw_sdk::error::SdkError;
use openclaw_sdk::types::agent::AgentRunParams;
use openclaw_sdk::types::gateway::GatewayHealth;
use openclaw_sdk::ws::methods::agent::AgentMethods;
use openclaw_sdk::ws::methods::status::StatusMethods;
use openclaw_sdk::ws::protocol::EventFrame;
use openclaw_sdk::ws::traits::GatewayRpc;

/// A mock implementation of GatewayRpc for testing.
struct MockRpc {
    response: serde_json::Value,
    event_tx: broadcast::Sender<EventFrame>,
}

impl MockRpc {
    fn new(response: serde_json::Value) -> Self {
        let (event_tx, _) = broadcast::channel(16);
        Self { response, event_tx }
    }

    fn with_error(code: &str, message: &str) -> Self {
        let (event_tx, _) = broadcast::channel(16);
        Self {
            response: serde_json::json!({
                "__mock_error": true,
                "code": code,
                "message": message,
            }),
            event_tx,
        }
    }
}

#[async_trait]
impl GatewayRpc for MockRpc {
    async fn request_raw(
        &self,
        _method: &str,
        _params: serde_json::Value,
    ) -> Result<serde_json::Value, SdkError> {
        if self.response.get("__mock_error").is_some() {
            return Err(SdkError::RpcError {
                code: self.response["code"].as_str().unwrap_or("").into(),
                message: self.response["message"].as_str().unwrap_or("").into(),
                details: None,
                retryable: None,
            });
        }
        Ok(self.response.clone())
    }

    async fn notify(
        &self,
        _method: &str,
        _params: impl serde::Serialize + Send,
    ) -> Result<(), SdkError> {
        Ok(())
    }

    fn subscribe_events(&self) -> broadcast::Receiver<EventFrame> {
        self.event_tx.subscribe()
    }

    fn subscribe(
        &self,
        _event_name: &str,
    ) -> Pin<Box<dyn futures_util::Stream<Item = EventFrame> + Send>> {
        Box::pin(futures_util::stream::empty())
    }

    fn is_connected(&self) -> bool {
        true
    }
}

#[tokio::test]
async fn test_status_health() {
    let mock = MockRpc::new(serde_json::json!({
        "status": "ok",
        "uptime_seconds": 3600,
        "version": "2026.3.1"
    }));

    let methods = StatusMethods::new(&mock);
    let health: GatewayHealth = methods.health().await.unwrap();
    assert_eq!(health.status, "ok");
    assert_eq!(health.uptime_seconds, Some(3600));
    assert_eq!(health.version.as_deref(), Some("2026.3.1"));
}

#[tokio::test]
async fn test_status_health_minimal() {
    // Only the required `status` field
    let mock = MockRpc::new(serde_json::json!({ "status": "ok" }));
    let methods = StatusMethods::new(&mock);
    let health = methods.health().await.unwrap();
    assert_eq!(health.status, "ok");
    assert!(health.uptime_seconds.is_none());
}

#[tokio::test]
async fn test_status_health_tolerant() {
    // Unknown extra fields should be captured in `extra`
    let mock = MockRpc::new(serde_json::json!({
        "status": "ok",
        "customField": 42
    }));
    let methods = StatusMethods::new(&mock);
    let health = methods.health().await.unwrap();
    assert!(health.extra.contains_key("customField"));
}

#[tokio::test]
async fn test_agent_run() {
    let mock = MockRpc::new(serde_json::json!({
        "reply": "Hello from the agent!"
    }));

    let methods = AgentMethods::new(&mock);
    let result = methods
        .run(AgentRunParams {
            message: "Hi".into(),
            ..Default::default()
        })
        .await
        .unwrap();

    assert_eq!(result.reply.as_deref(), Some("Hello from the agent!"));
}

#[tokio::test]
async fn test_rpc_error_propagation() {
    let mock = MockRpc::with_error("NOT_LINKED", "channel not linked");
    let methods = StatusMethods::new(&mock);

    let result = methods.health().await;
    assert!(result.is_err());

    match result.unwrap_err() {
        SdkError::RpcError { code, message, .. } => {
            assert_eq!(code, "NOT_LINKED");
            assert_eq!(message, "channel not linked");
        }
        other => panic!("expected RpcError, got: {other}"),
    }
}
