pub mod error;
pub mod types;

#[cfg(feature = "ws")]
pub mod ws;

#[cfg(feature = "cli")]
pub mod cli;

#[cfg(all(feature = "ws", feature = "cli"))]
pub mod sdk;

// Re-exports
pub use error::SdkError;

#[cfg(feature = "ws")]
pub use ws::actor::{ConnectOptions, DisconnectPolicy};
#[cfg(feature = "ws")]
pub use ws::client::GatewayClient;
#[cfg(feature = "ws")]
pub use ws::protocol::EventFrame;
#[cfg(feature = "ws")]
pub use ws::traits::GatewayRpc;

#[cfg(feature = "cli")]
pub use cli::executor::{CliExecutor, CliOptions};
#[cfg(feature = "cli")]
pub use cli::traits::{CliExec, CommandOutput};

#[cfg(all(feature = "ws", feature = "cli"))]
pub use sdk::{DefaultSdk, OpenClawSdk, SdkOptions};
