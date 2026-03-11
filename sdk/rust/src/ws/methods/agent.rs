use crate::error::SdkError;
use crate::types::agent::{AgentRunParams, AgentTurnResult, AgentWaitParams};
use crate::ws::traits::GatewayRpc;

/// Agent RPC methods.
pub struct AgentMethods<'a, G: GatewayRpc> {
    pub(crate) rpc: &'a G,
}

impl<'a, G: GatewayRpc> AgentMethods<'a, G> {
    /// Create a new AgentMethods instance.
    pub fn new(rpc: &'a G) -> Self {
        Self { rpc }
    }

    /// Run a single agent turn.
    pub async fn run(&self, params: AgentRunParams) -> Result<AgentTurnResult, SdkError> {
        self.rpc.request("agent", params).await
    }

    /// Wait for an in-progress agent turn to complete.
    pub async fn wait(&self, params: AgentWaitParams) -> Result<AgentTurnResult, SdkError> {
        self.rpc.request("agent.wait", params).await
    }
}
