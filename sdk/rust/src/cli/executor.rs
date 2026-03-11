use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use async_trait::async_trait;

use crate::cli::traits::{CliExec, CommandOutput};
use crate::error::SdkError;

/// Minimum CLI version required by this SDK.
const MIN_CLI_VERSION: &str = "2026.1.0";

/// Environment variables allowed to pass through to the CLI subprocess.
const CLI_ENV_ALLOWLIST: &[&str] = &[
    "HOME",
    "PATH",
    "USER",
    "SHELL",
    "LANG",
    "TERM",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_GATEWAY_TOKEN",
    "OPENCLAW_GATEWAY_PASSWORD",
    "NO_COLOR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "NODE_OPTIONS",
];

/// CLI subprocess executor.
///
/// Spawns `openclaw` processes with a sanitized environment
/// (only allowlisted env vars are passed through).
pub struct CliExecutor {
    bin_path: PathBuf,
    global_flags: GlobalFlags,
    timeout: Duration,
    env: HashMap<String, String>,
}

/// Global CLI flags applied to all commands.
#[derive(Debug, Clone, Default)]
pub struct GlobalFlags {
    pub dev: bool,
    pub profile: Option<String>,
}

/// Options for creating a `CliExecutor`.
#[derive(Debug, Clone)]
pub struct CliOptions {
    /// Explicit path to the `openclaw` binary (None = search PATH).
    pub bin_path: Option<PathBuf>,
    pub global_flags: GlobalFlags,
    /// Per-command timeout (default 120s).
    pub timeout: Duration,
    /// Whether to check CLI version on creation (default true).
    pub check_version: bool,
}

impl Default for CliOptions {
    fn default() -> Self {
        Self {
            bin_path: None,
            global_flags: GlobalFlags::default(),
            timeout: Duration::from_secs(120),
            check_version: true,
        }
    }
}

impl CliExecutor {
    /// Create a new CLI executor.
    ///
    /// Resolves the `openclaw` binary path and builds the sanitized environment.
    pub fn new(opts: CliOptions) -> Result<Self, SdkError> {
        let bin_path = match opts.bin_path {
            Some(p) => p,
            None => which::which("openclaw").map_err(|_| {
                SdkError::BinaryNotFound("openclaw not found in PATH".into())
            })?,
        };

        let env: HashMap<String, String> = CLI_ENV_ALLOWLIST
            .iter()
            .filter_map(|key| {
                std::env::var(key)
                    .ok()
                    .map(|val| (key.to_string(), val))
            })
            .collect();

        Ok(Self {
            bin_path,
            global_flags: opts.global_flags,
            timeout: opts.timeout,
            env,
        })
    }

    /// Get the path to the `openclaw` binary.
    pub fn bin_path(&self) -> &PathBuf {
        &self.bin_path
    }

    /// Check the CLI version and return it.
    pub async fn check_version(&self) -> Result<String, SdkError> {
        let output = self.exec_raw(&["--version"]).await?;
        let version = output.stdout.trim().to_string();
        // Simple version comparison (YYYY.M.D format)
        if version < MIN_CLI_VERSION.to_string() {
            return Err(SdkError::VersionTooOld {
                found: version,
                min: MIN_CLI_VERSION.into(),
            });
        }
        Ok(version)
    }

    fn build_command(&self, args: &[&str]) -> tokio::process::Command {
        let mut cmd = tokio::process::Command::new(&self.bin_path);
        cmd.env_clear();
        cmd.envs(&self.env);
        cmd.arg("--no-color");

        if self.global_flags.dev {
            cmd.arg("--dev");
        }
        if let Some(ref profile) = self.global_flags.profile {
            cmd.args(["--profile", profile]);
        }

        cmd.args(args);
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
        cmd
    }
}

#[async_trait]
impl CliExec for CliExecutor {
    async fn exec_json(&self, args: &[&str]) -> Result<serde_json::Value, SdkError> {
        let mut full_args: Vec<&str> = args.to_vec();
        if !full_args.contains(&"--json") {
            full_args.push("--json");
        }
        let output = self.exec_raw(&full_args).await?;
        if output.exit_code != 0 {
            return Err(SdkError::CommandFailed {
                code: output.exit_code,
                stderr: output.stderr,
            });
        }
        Ok(serde_json::from_str(&output.stdout)?)
    }

    async fn exec_raw(&self, args: &[&str]) -> Result<CommandOutput, SdkError> {
        let mut cmd = self.build_command(args);
        let child = cmd.spawn()?;

        let result = tokio::time::timeout(self.timeout, child.wait_with_output()).await;
        match result {
            Ok(Ok(output)) => Ok(CommandOutput {
                stdout: String::from_utf8_lossy(&output.stdout).into(),
                stderr: String::from_utf8_lossy(&output.stderr).into(),
                exit_code: output.status.code().unwrap_or(-1),
            }),
            Ok(Err(e)) => Err(SdkError::Io(e.to_string())),
            Err(_) => Err(SdkError::CommandTimeout(self.timeout)),
        }
    }
}
