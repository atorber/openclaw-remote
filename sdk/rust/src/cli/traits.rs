use async_trait::async_trait;

use crate::error::SdkError;

/// Output from a CLI subprocess execution.
#[derive(Debug, Clone)]
pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

/// Trait abstracting CLI subprocess execution.
///
/// This trait enables mock-based unit testing of CLI command wrappers
/// without spawning real processes.
#[async_trait]
pub trait CliExec: Send + Sync {
    /// Execute a CLI command and parse its `--json` output.
    async fn exec_json(&self, args: &[&str]) -> Result<serde_json::Value, SdkError>;

    /// Execute a CLI command and return raw output.
    async fn exec_raw(&self, args: &[&str]) -> Result<CommandOutput, SdkError>;
}
