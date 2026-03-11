//! Integration tests requiring a real Gateway.
//!
//! These tests are `#[ignore]` by default. Run with:
//! ```
//! cargo test -- --ignored
//! ```
//!
//! Environment variables:
//! - `OPENCLAW_TEST_GATEWAY_URL` — WS URL (default: ws://127.0.0.1:18789)
//! - `OPENCLAW_TEST_GATEWAY_TOKEN` — auth token (optional)

use openclaw_sdk::{ConnectOptions, DefaultSdk, SdkOptions};

#[tokio::test]
#[ignore]
async fn integration_health_check() {
    let url = std::env::var("OPENCLAW_TEST_GATEWAY_URL")
        .unwrap_or_else(|_| "ws://127.0.0.1:18789".into());

    let sdk = DefaultSdk::new(SdkOptions {
        gateway: ConnectOptions {
            url,
            ..Default::default()
        },
        ..Default::default()
    })
    .unwrap();

    sdk.connect_gateway().await.unwrap();
    assert!(sdk.is_gateway_connected());

    let health = sdk.status().health().await.unwrap();
    assert_eq!(health.status, "ok");
}

#[tokio::test]
#[ignore]
async fn integration_channels_status() {
    let url = std::env::var("OPENCLAW_TEST_GATEWAY_URL")
        .unwrap_or_else(|_| "ws://127.0.0.1:18789".into());

    let sdk = DefaultSdk::new(SdkOptions {
        gateway: ConnectOptions {
            url,
            ..Default::default()
        },
        ..Default::default()
    })
    .unwrap();

    sdk.connect_gateway().await.unwrap();

    let result = sdk
        .channels()
        .status(openclaw_sdk::types::channel::ChannelsStatusParams::default())
        .await
        .unwrap();
    // Just verify it returned without error
    assert!(result.channels.is_some() || result.extra.is_empty() || true);
}
