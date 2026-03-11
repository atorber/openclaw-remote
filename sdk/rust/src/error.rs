use std::time::Duration;

/// Unified error type for the OpenClaw SDK.
///
/// All errors are `Clone` to support broadcast channel distribution.
/// `From` impls for non-Clone types (io::Error, serde_json::Error) convert to String.
#[derive(Debug, Clone, thiserror::Error)]
pub enum SdkError {
    // ---- WS layer ----
    #[error("ws connect failed: {0}")]
    WsConnect(String),

    #[error("handshake failed: {0}")]
    HandshakeFailed(String),

    #[error("gateway not connected (call connect_gateway() first)")]
    GatewayNotConnected,

    #[error("ws disconnected: {reason}")]
    Disconnected { reason: String },

    #[error("request timed out after {0:?}")]
    RequestTimeout(Duration),

    #[error("rpc error [{code}]: {message}")]
    RpcError {
        code: String,
        message: String,
        details: Option<serde_json::Value>,
        retryable: Option<bool>,
    },

    // ---- CLI layer ----
    #[error("openclaw binary not found: {0}")]
    BinaryNotFound(String),

    #[error("openclaw version {found} < minimum {min}")]
    VersionTooOld { found: String, min: String },

    #[error("command failed (exit {code}): {stderr}")]
    CommandFailed { code: i32, stderr: String },

    #[error("command timed out after {0:?}")]
    CommandTimeout(Duration),

    // ---- Common ----
    #[error("json parse error: {0}")]
    Parse(String),

    #[error("io error: {0}")]
    Io(String),
}

impl From<serde_json::Error> for SdkError {
    fn from(e: serde_json::Error) -> Self {
        Self::Parse(e.to_string())
    }
}

impl From<std::io::Error> for SdkError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e.to_string())
    }
}
