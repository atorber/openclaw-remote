# openclaw-sdk

Rust SDK for the OpenClaw Gateway, providing typed access to the Gateway's WS RPC interface and local CLI commands. Designed as the backend layer for Tauri desktop applications.

## Architecture

The SDK communicates through two channels:

- **WebSocket** (primary) — real-time RPC calls and event streaming via the Gateway's JSON frame protocol
- **CLI subprocess** (auxiliary) — local management commands (`doctor`, etc.) via the `openclaw` binary

```
┌───────────────────────────────┐
│         OpenClawSdk           │
│  ┌─────────────┬────────────┐ │
│  │ GatewayRpc  │  CliExec   │ │
│  │ (WS actor)  │ (subprocess│ │
│  └──────┬──────┴─────┬──────┘ │
└─────────┼────────────┼────────┘
          │            │
    WS JSON frames   stdin/stdout
          │            │
    ┌─────▼─────┐  ┌───▼───┐
    │  Gateway   │  │openclaw│
    │  Server    │  │ binary │
    └───────────┘  └───────┘
```

## Installation

Add to your `Cargo.toml`:

```toml
[dependencies]
openclaw-sdk = { path = "../openclaw-remote/sdk/rust" }
```

### Feature Flags

| Feature | Default | Description |
|---------|---------|-------------|
| `ws`    | yes     | WebSocket RPC layer (tokio-tungstenite, Ed25519 auth, event streaming) |
| `cli`   | yes     | CLI subprocess layer (openclaw binary execution) |

Use only the layer you need:

```toml
# WS only
openclaw-sdk = { path = "...", default-features = false, features = ["ws"] }

# CLI only
openclaw-sdk = { path = "...", default-features = false, features = ["cli"] }
```

## Quick Start

```rust
use openclaw_sdk::{DefaultSdk, SdkOptions, ConnectOptions};
use openclaw_sdk::types::agent::AgentRunParams;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Phase 1: Create SDK synchronously (CLI ready immediately)
    let sdk = DefaultSdk::new(SdkOptions {
        gateway: ConnectOptions {
            url: "ws://127.0.0.1:18789".into(),
            ..Default::default()
        },
        ..Default::default()
    })?;

    // Phase 2: Connect to Gateway asynchronously
    sdk.connect_gateway().await?;

    // Check health
    let health = sdk.status().health().await?;
    println!("Gateway status: {}", health.status);

    // Run an agent turn
    let result = sdk.agent().run(AgentRunParams {
        message: "Hello!".into(),
        ..Default::default()
    }).await?;
    println!("Agent reply: {:?}", result.reply);

    // Subscribe to events
    let mut events = sdk.events();
    tokio::spawn(async move {
        while let Ok(event) = events.recv().await {
            println!("Event: {} {}", event.event, event.data);
        }
    });

    // Disconnect
    sdk.disconnect_gateway().await;
    Ok(())
}
```

## API Reference

### Method Groups

Access typed RPC methods through the SDK:

| Accessor | Methods | Description |
|----------|---------|-------------|
| `sdk.status()` | `health()`, `status()`, `presence()`, `last_heartbeat()` | Gateway status and health |
| `sdk.agent()` | `run()`, `wait()` | Agent conversation turns |
| `sdk.message()` | `send()` | Send messages to contacts |
| `sdk.channels()` | `status()`, `logout()` | Channel management |
| `sdk.config()` | `get()`, `set()`, `apply()`, `patch()`, `schema()` | Configuration |
| `sdk.chat()` | `send()`, `history()`, `abort()`, `stream()` | WebChat with streaming |

### CLI Commands

| Accessor | Methods | Description |
|----------|---------|-------------|
| `sdk.doctor()` | `run()` | Health check and repair |

### Error Handling

All operations return `Result<T, SdkError>`. The error enum covers both layers:

```rust
match result {
    Err(SdkError::RpcError { code, message, .. }) => { /* server-side error */ }
    Err(SdkError::RequestTimeout(_)) => { /* request timed out */ }
    Err(SdkError::GatewayNotConnected) => { /* forgot connect_gateway()? */ }
    Err(SdkError::CommandFailed { code, stderr }) => { /* CLI command failed */ }
    _ => {}
}
```

## Configuration

### Authentication Resolution

The SDK resolves authentication credentials in this order:

1. Explicit values in `ConnectOptions.auth`
2. Environment variables: `OPENCLAW_GATEWAY_TOKEN`, `OPENCLAW_GATEWAY_PASSWORD`
3. Config file: `~/.openclaw/openclaw.json` (`gateway.auth.*` fields)

### ConnectOptions

```rust
ConnectOptions {
    url: "ws://127.0.0.1:18789".into(),
    auth: AuthConfig::default(),              // auto-resolved
    device_identity: None,                     // optional Ed25519 identity
    connect_timeout: Duration::from_secs(10),
    request_timeout: Duration::from_secs(60),
    auto_reconnect: true,
    disconnect_policy: DisconnectPolicy::FailFast,
}
```

`DisconnectPolicy` controls behavior when requests are made during reconnection:
- `FailFast` — immediately return `SdkError::Disconnected`
- `WaitReconnect` — queue the request until reconnection succeeds

## Testing

The SDK uses trait abstractions (`GatewayRpc`, `CliExec`) for testability. Mock either trait to unit-test your application code without a real Gateway.

```rust
use openclaw_sdk::ws::methods::status::StatusMethods;

// Create a mock implementing GatewayRpc, then:
let methods = StatusMethods::new(&mock);
let health = methods.health().await.unwrap();
```

Run the test suite:

```bash
# Unit tests (no Gateway needed)
cargo test

# Integration tests (requires running Gateway)
OPENCLAW_TEST_GATEWAY_URL=ws://127.0.0.1:18789 \
OPENCLAW_TEST_GATEWAY_TOKEN=your-token \
cargo test -- --ignored
```

## Internal Design

- **Actor model**: A dedicated tokio task (`WsActor`) owns the WebSocket read/write halves, avoiding Mutex contention
- **DashMap**: Lock-free concurrent map for tracking pending RPC requests
- **Broadcast channel**: Multi-subscriber event distribution (capacity 256) with `Lagged` warning via `tracing`
- **Ed25519 device auth**: `ed25519-dalek` for key generation/signing, `sha2` for device ID derivation
- **Exponential backoff**: 1s min, 30s max, 2x factor for reconnection attempts
- **Environment isolation**: CLI subprocess uses `env_clear()` + allowlist for security

## License

MIT
