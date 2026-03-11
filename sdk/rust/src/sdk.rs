use tokio::sync::broadcast;

use crate::cli::commands::doctor::DoctorCmd;
use crate::cli::executor::{CliExecutor, CliOptions};
use crate::cli::traits::CliExec;
use crate::error::SdkError;
use crate::ws::actor::ConnectOptions;
use crate::ws::client::GatewayClient;
use crate::ws::methods::agent::AgentMethods;
use crate::ws::methods::channels::ChannelMethods;
use crate::ws::methods::chat::ChatMethods;
use crate::ws::methods::config::ConfigMethods;
use crate::ws::methods::message::MessageMethods;
use crate::ws::methods::status::StatusMethods;
use crate::ws::protocol::EventFrame;
use crate::ws::traits::GatewayRpc;

/// Options for creating an `OpenClawSdk` instance.
pub struct SdkOptions {
    pub gateway: ConnectOptions,
    pub cli: CliOptions,
}

impl Default for SdkOptions {
    fn default() -> Self {
        Self {
            gateway: ConnectOptions::default(),
            cli: CliOptions::default(),
        }
    }
}

/// Unified SDK entry point combining WS and CLI layers.
///
/// Generic over `G: GatewayRpc` and `C: CliExec` to support mock-based testing.
/// Use `DefaultSdk` for production code.
pub struct OpenClawSdk<G: GatewayRpc = GatewayClient, C: CliExec = CliExecutor> {
    gateway: G,
    cli: C,
}

/// Concrete SDK type alias for production use.
pub type DefaultSdk = OpenClawSdk<GatewayClient, CliExecutor>;

impl DefaultSdk {
    /// Phase 1: Create the SDK synchronously (CLI layer ready, WS layer not connected).
    pub fn new(opts: SdkOptions) -> Result<Self, SdkError> {
        let cli = CliExecutor::new(opts.cli)?;
        let gateway = GatewayClient::new(opts.gateway);
        Ok(Self { gateway, cli })
    }

    /// Phase 2: Connect to the Gateway asynchronously (idempotent).
    pub async fn connect_gateway(&self) -> Result<(), SdkError> {
        self.gateway.connect().await
    }

    /// Whether the Gateway connection is active.
    pub fn is_gateway_connected(&self) -> bool {
        self.gateway.is_connected()
    }

    /// Disconnect from the Gateway.
    pub async fn disconnect_gateway(&self) {
        self.gateway.disconnect().await
    }

    /// Subscribe to all Gateway events.
    pub fn events(&self) -> broadcast::Receiver<EventFrame> {
        self.gateway.subscribe_events()
    }
}

impl<G: GatewayRpc, C: CliExec> OpenClawSdk<G, C> {
    /// Create an SDK from pre-built components (useful for testing with mocks).
    pub fn from_parts(gateway: G, cli: C) -> Self {
        Self { gateway, cli }
    }

    /// Access the underlying Gateway RPC client.
    pub fn gateway(&self) -> &G {
        &self.gateway
    }

    /// Access the underlying CLI executor.
    pub fn cli(&self) -> &C {
        &self.cli
    }

    // ---- WS method groups ----

    /// Status and health methods.
    pub fn status(&self) -> StatusMethods<'_, G> {
        StatusMethods { rpc: &self.gateway }
    }

    /// Agent turn methods.
    pub fn agent(&self) -> AgentMethods<'_, G> {
        AgentMethods { rpc: &self.gateway }
    }

    /// Message sending methods.
    pub fn message(&self) -> MessageMethods<'_, G> {
        MessageMethods { rpc: &self.gateway }
    }

    /// Channel management methods.
    pub fn channels(&self) -> ChannelMethods<'_, G> {
        ChannelMethods { rpc: &self.gateway }
    }

    /// Configuration methods.
    pub fn config(&self) -> ConfigMethods<'_, G> {
        ConfigMethods { rpc: &self.gateway }
    }

    /// WebChat methods.
    pub fn chat(&self) -> ChatMethods<'_, G> {
        ChatMethods { rpc: &self.gateway }
    }

    // ---- CLI command groups ----

    /// Doctor (health check + repair) command.
    pub fn doctor(&self) -> DoctorCmd<'_, C> {
        DoctorCmd { cli: &self.cli }
    }
}
