use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Authentication credentials for the Gateway.
#[derive(Debug, Clone, Default)]
pub struct AuthConfig {
    pub token: Option<String>,
    pub password: Option<String>,
}

impl AuthConfig {
    /// Resolve credentials with priority: explicit > env vars > config file.
    pub fn resolve(explicit: Option<AuthConfig>) -> Self {
        // 1. Explicit
        if let Some(auth) = explicit {
            if auth.token.is_some() || auth.password.is_some() {
                return auth;
            }
        }

        // 2. Environment variables
        let token = std::env::var("OPENCLAW_GATEWAY_TOKEN").ok();
        let password = std::env::var("OPENCLAW_GATEWAY_PASSWORD").ok();
        if token.is_some() || password.is_some() {
            return Self { token, password };
        }

        // 3. Config file
        if let Some(auth) = Self::from_config_file() {
            return auth;
        }

        Self::default()
    }

    fn from_config_file() -> Option<Self> {
        let config_path = std::env::var("OPENCLAW_CONFIG_PATH")
            .map(PathBuf::from)
            .ok()
            .or_else(|| dirs::home_dir().map(|h| h.join(".openclaw").join("openclaw.json")))?;

        let content = std::fs::read_to_string(&config_path).ok()?;
        let config: serde_json::Value = serde_json::from_str(&content).ok()?;
        let gateway = config.get("gateway")?.get("auth")?;

        Some(Self {
            token: gateway
                .get("token")
                .and_then(|v| v.as_str())
                .map(String::from),
            password: gateway
                .get("password")
                .and_then(|v| v.as_str())
                .map(String::from),
        })
    }
}

/// Ed25519 device identity for Gateway authentication.
#[cfg(feature = "ws")]
pub struct DeviceIdentity {
    // Note: Debug is manually implemented below to avoid exposing the signing key.
    /// SHA-256 of the raw 32-byte public key, hex-encoded.
    pub device_id: String,
    /// Ed25519 signing key.
    pub signing_key: ed25519_dalek::SigningKey,
}

#[cfg(feature = "ws")]
impl std::fmt::Debug for DeviceIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeviceIdentity")
            .field("device_id", &self.device_id)
            .field("signing_key", &"[redacted]")
            .finish()
    }
}

#[cfg(feature = "ws")]
impl DeviceIdentity {
    /// Generate a new random device identity.
    pub fn generate() -> Self {
        use ed25519_dalek::SigningKey;
        use sha2::{Digest, Sha256};
        let signing_key = SigningKey::generate(&mut rand_core::OsRng);
        let public_bytes = signing_key.verifying_key().to_bytes();
        let device_id = hex::encode(Sha256::digest(public_bytes));

        Self {
            device_id,
            signing_key,
        }
    }

    /// Get the raw 32-byte public key as base64url (no padding).
    pub fn public_key_base64url(&self) -> String {
        use base64::engine::general_purpose::URL_SAFE_NO_PAD;
        use base64::Engine;
        URL_SAFE_NO_PAD.encode(self.signing_key.verifying_key().to_bytes())
    }

    /// Build the v3 signature payload string.
    ///
    /// Format: `v3|{deviceId}|{clientId}|{clientMode}|{role}|{scopes}|{signedAtMs}|{token}|{nonce}|{platform}|{deviceFamily}`
    pub fn build_signature_payload_v3(
        &self,
        client_id: &str,
        client_mode: &str,
        role: &str,
        scopes: &[&str],
        signed_at_ms: u64,
        token: &str,
        nonce: &str,
        platform: &str,
        device_family: &str,
    ) -> String {
        let scopes_str = scopes.join(",");
        let platform_norm = normalize_device_metadata(platform);
        let family_norm = normalize_device_metadata(device_family);
        format!(
            "v3|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
            self.device_id,
            client_id,
            client_mode,
            role,
            scopes_str,
            signed_at_ms,
            token,
            nonce,
            platform_norm,
            family_norm,
        )
    }

    /// Sign a payload string and return the base64url-encoded signature.
    pub fn sign(&self, payload: &str) -> String {
        use base64::engine::general_purpose::URL_SAFE_NO_PAD;
        use base64::Engine;
        use ed25519_dalek::Signer;

        let signature = self.signing_key.sign(payload.as_bytes());
        URL_SAFE_NO_PAD.encode(signature.to_bytes())
    }
}

/// Normalize device metadata for auth: trim whitespace, lowercase ASCII.
fn normalize_device_metadata(s: &str) -> String {
    s.trim().to_ascii_lowercase()
}

/// Handshake auth payload sent in the connect request.
#[derive(Debug, Clone, Serialize, Default)]
pub struct AuthPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "deviceToken")]
    pub device_token: Option<String>,
}

/// Device auth params for the connect request.
#[derive(Debug, Clone, Serialize)]
pub struct DeviceAuthParams {
    pub id: String,
    #[serde(rename = "publicKey")]
    pub public_key: String,
    pub signature: String,
    #[serde(rename = "signedAt")]
    pub signed_at: u64,
    pub nonce: String,
}

/// Server info returned in hello-ok.
#[derive(Debug, Clone, Deserialize)]
pub struct ServerInfo {
    pub version: String,
    #[serde(rename = "connId")]
    pub conn_id: String,
}

/// Features advertised in hello-ok.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct Features {
    #[serde(default)]
    pub methods: Vec<String>,
    #[serde(default)]
    pub events: Vec<String>,
}

/// Auth info returned in hello-ok.
#[derive(Debug, Clone, Deserialize)]
pub struct HelloAuth {
    #[serde(default, rename = "deviceToken")]
    pub device_token: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub scopes: Vec<String>,
}

/// Server policy returned in hello-ok.
#[derive(Debug, Clone, Deserialize)]
pub struct Policy {
    #[serde(default, rename = "maxPayload")]
    pub max_payload: Option<u64>,
    #[serde(default, rename = "maxBufferedBytes")]
    pub max_buffered_bytes: Option<u64>,
    #[serde(default, rename = "tickIntervalMs")]
    pub tick_interval_ms: Option<u64>,
}

/// Complete hello-ok response from the Gateway.
#[derive(Debug, Clone, Deserialize)]
pub struct HelloOk {
    #[serde(default)]
    pub protocol: Option<u32>,
    #[serde(default)]
    pub server: Option<ServerInfo>,
    #[serde(default)]
    pub features: Option<Features>,
    #[serde(default)]
    pub snapshot: Option<serde_json::Value>,
    #[serde(default, rename = "canvasHostUrl")]
    pub canvas_host_url: Option<String>,
    #[serde(default)]
    pub auth: Option<HelloAuth>,
    #[serde(default)]
    pub policy: Option<Policy>,
}

/// Private module for hex encoding (minimal, avoids extra dep).
mod hex {
    pub fn encode(bytes: impl AsRef<[u8]>) -> String {
        bytes
            .as_ref()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_auth_resolve_explicit() {
        let auth = AuthConfig::resolve(Some(AuthConfig {
            token: Some("my-token".into()),
            password: None,
        }));
        assert_eq!(auth.token.as_deref(), Some("my-token"));
    }

    #[test]
    fn test_auth_resolve_fallback_empty() {
        // Save and clear env vars
        let saved_token = std::env::var("OPENCLAW_GATEWAY_TOKEN").ok();
        let saved_pass = std::env::var("OPENCLAW_GATEWAY_PASSWORD").ok();
        let saved_config = std::env::var("OPENCLAW_CONFIG_PATH").ok();
        std::env::remove_var("OPENCLAW_GATEWAY_TOKEN");
        std::env::remove_var("OPENCLAW_GATEWAY_PASSWORD");
        // Point config to a nonexistent path so file-based resolution fails
        std::env::set_var("OPENCLAW_CONFIG_PATH", "/tmp/nonexistent-openclaw-test.json");

        let auth = AuthConfig::resolve(None);
        assert!(auth.token.is_none());
        assert!(auth.password.is_none());

        // Restore env vars
        if let Some(v) = saved_token { std::env::set_var("OPENCLAW_GATEWAY_TOKEN", v); }
        if let Some(v) = saved_pass { std::env::set_var("OPENCLAW_GATEWAY_PASSWORD", v); }
        if let Some(v) = saved_config { std::env::set_var("OPENCLAW_CONFIG_PATH", v); } else { std::env::remove_var("OPENCLAW_CONFIG_PATH"); }
    }

    #[test]
    fn test_normalize_device_metadata() {
        assert_eq!(normalize_device_metadata("  MacOS  "), "macos");
        assert_eq!(normalize_device_metadata("Linux"), "linux");
        assert_eq!(normalize_device_metadata(""), "");
    }

    #[cfg(feature = "ws")]
    #[test]
    fn test_device_identity_generate() {
        let id = DeviceIdentity::generate();
        // device_id is hex-encoded SHA-256 = 64 chars
        assert_eq!(id.device_id.len(), 64);
        // public key is base64url of 32 bytes
        let pk = id.public_key_base64url();
        assert!(!pk.is_empty());
    }

    #[cfg(feature = "ws")]
    #[test]
    fn test_signature_payload_v3_format() {
        let id = DeviceIdentity::generate();
        let payload = id.build_signature_payload_v3(
            "openclaw-control-ui",
            "ui",
            "operator",
            &["operator.admin", "operator.approvals"],
            1700000000000,
            "test-token",
            "test-nonce",
            "darwin",
            "MacBookPro",
        );
        assert!(payload.starts_with("v3|"));
        let parts: Vec<&str> = payload.split('|').collect();
        assert_eq!(parts.len(), 11);
        assert_eq!(parts[0], "v3");
        assert_eq!(parts[1], &id.device_id);
        assert_eq!(parts[2], "openclaw-control-ui");
        assert_eq!(parts[3], "ui");
        assert_eq!(parts[4], "operator");
        assert_eq!(parts[5], "operator.admin,operator.approvals");
        assert_eq!(parts[6], "1700000000000");
        assert_eq!(parts[7], "test-token");
        assert_eq!(parts[8], "test-nonce");
        assert_eq!(parts[9], "darwin");
        assert_eq!(parts[10], "macbookpro"); // lowercased
    }

    #[cfg(feature = "ws")]
    #[test]
    fn test_sign_round_trip() {
        let id = DeviceIdentity::generate();
        let payload = "test-payload";
        let sig = id.sign(payload);
        assert!(!sig.is_empty());
        // Verify: decode sig and verify with public key
        use base64::engine::general_purpose::URL_SAFE_NO_PAD;
        use base64::Engine;
        use ed25519_dalek::Verifier;
        let sig_bytes = URL_SAFE_NO_PAD.decode(&sig).unwrap();
        let signature = ed25519_dalek::Signature::from_bytes(
            sig_bytes.as_slice().try_into().unwrap(),
        );
        id.signing_key
            .verifying_key()
            .verify(payload.as_bytes(), &signature)
            .unwrap();
    }
}
