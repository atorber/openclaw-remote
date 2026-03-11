use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use dashmap::DashMap;
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

use crate::error::SdkError;
use crate::ws::auth::{
    AuthConfig, AuthPayload, DeviceAuthParams, DeviceIdentity, HelloOk, ServerInfo,
};
use crate::ws::handshake::{
    ConnectParams, CHALLENGE_TIMEOUT_MS, CLIENT_ID, CLIENT_MODE, DEFAULT_ROLE, DEFAULT_SCOPES,
};
use crate::ws::protocol::{EventFrame, InboundFrame, RequestFrame};
use crate::ws::reconnect::ExponentialBackoff;

/// Type alias for the split WS stream halves.
type WsSink = SplitSink<WebSocketStream<MaybeTlsStream<TcpStream>>, Message>;
type WsStreamHalf = SplitStream<WebSocketStream<MaybeTlsStream<TcpStream>>>;

/// Pending request map: request ID → response sender.
type PendingMap = Arc<DashMap<String, oneshot::Sender<Result<serde_json::Value, SdkError>>>>;

/// Commands sent from `GatewayClient` to `WsActor`.
pub(crate) enum ActorCommand {
    /// Initiate connection to the Gateway.
    Connect {
        respond_to: oneshot::Sender<Result<(), SdkError>>,
    },
    /// Send an RPC request.
    Request {
        id: String,
        method: String,
        params: serde_json::Value,
        respond_to: oneshot::Sender<Result<serde_json::Value, SdkError>>,
    },
    /// Send a fire-and-forget notification.
    Notify {
        method: String,
        params: serde_json::Value,
    },
    /// Graceful shutdown.
    Shutdown,
}

/// Internal actor state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ActorState {
    Disconnected,
    Connecting,
    Handshaking,
    Connected,
    Reconnecting,
}

/// Options for the WS connection.
#[derive(Debug, Clone)]
pub struct ConnectOptions {
    /// WebSocket URL (e.g., "ws://127.0.0.1:18789").
    pub url: String,
    /// Authentication credentials.
    pub auth: AuthConfig,
    /// Optional device identity for Ed25519 auth.
    pub device_identity: Option<Arc<DeviceIdentity>>,
    /// Timeout for the initial connection + handshake.
    pub connect_timeout: Duration,
    /// Timeout for individual RPC requests.
    pub request_timeout: Duration,
    /// Whether to automatically reconnect on disconnect.
    pub auto_reconnect: bool,
    /// Behavior when a request is made while disconnected.
    pub disconnect_policy: DisconnectPolicy,
}

/// Policy for handling requests while disconnected.
#[derive(Debug, Clone)]
pub enum DisconnectPolicy {
    /// Return `SdkError::GatewayNotConnected` immediately.
    FailFast,
    /// Queue the request and wait up to `Duration` for reconnection.
    WaitReconnect(Duration),
}

impl Default for ConnectOptions {
    fn default() -> Self {
        Self {
            url: "ws://127.0.0.1:18789".into(),
            auth: AuthConfig::resolve(None),
            device_identity: None,
            connect_timeout: Duration::from_secs(10),
            request_timeout: Duration::from_secs(60),
            auto_reconnect: true,
            disconnect_policy: DisconnectPolicy::FailFast,
        }
    }
}

/// The WsActor owns the WebSocket connection and runs as a dedicated tokio task.
///
/// External code communicates with it via `ActorCommand` messages through an mpsc channel.
pub(crate) struct WsActor {
    pub opts: ConnectOptions,
    pub cmd_rx: mpsc::Receiver<ActorCommand>,
    pub event_tx: broadcast::Sender<EventFrame>,
    pub pending: PendingMap,
    pub server_info: Arc<tokio::sync::RwLock<Option<ServerInfo>>>,
    pub connected: Arc<AtomicBool>,
    pub backoff: ExponentialBackoff,
    // WS connection halves (only present when connected)
    sink: Option<WsSink>,
    stream: Option<WsStreamHalf>,
    state: ActorState,
    // Cached device token from server for reconnection
    device_token: Option<String>,
    // Connect command responder (used during initial connect)
    connect_responder: Option<oneshot::Sender<Result<(), SdkError>>>,
}

impl WsActor {
    pub fn new(
        opts: ConnectOptions,
        cmd_rx: mpsc::Receiver<ActorCommand>,
        event_tx: broadcast::Sender<EventFrame>,
        pending: PendingMap,
        server_info: Arc<tokio::sync::RwLock<Option<ServerInfo>>>,
        connected: Arc<AtomicBool>,
    ) -> Self {
        Self {
            opts,
            cmd_rx,
            event_tx,
            pending,
            server_info,
            connected,
            backoff: ExponentialBackoff::default(),
            sink: None,
            stream: None,
            state: ActorState::Disconnected,
            device_token: None,
            connect_responder: None,
        }
    }

    /// Main actor loop.
    pub async fn run(mut self) {
        loop {
            match self.state {
                ActorState::Disconnected => {
                    // Wait for a Connect command or Shutdown
                    match self.cmd_rx.recv().await {
                        Some(ActorCommand::Connect { respond_to }) => {
                            self.connect_responder = Some(respond_to);
                            self.do_connect().await;
                        }
                        Some(ActorCommand::Request { respond_to, .. }) => {
                            let _ =
                                respond_to.send(Err(SdkError::GatewayNotConnected));
                        }
                        Some(ActorCommand::Notify { .. }) => {}
                        Some(ActorCommand::Shutdown) | None => break,
                    }
                }
                ActorState::Connecting | ActorState::Handshaking => {
                    // These states are transient — handled inside do_connect
                    // If we reach here, something went wrong; fall back to disconnected
                    self.state = ActorState::Disconnected;
                }
                ActorState::Connected => {
                    self.run_connected().await;
                }
                ActorState::Reconnecting => {
                    let delay = self.backoff.next_delay();
                    tracing::info!("reconnecting in {:?}", delay);
                    tokio::time::sleep(delay).await;
                    self.do_connect().await;
                }
            }
        }

        // Cleanup
        self.connected.store(false, Ordering::Relaxed);
        self.flush_pending(SdkError::Disconnected {
            reason: "actor shutdown".into(),
        });
    }

    /// Attempt to establish a WS connection and complete the handshake.
    async fn do_connect(&mut self) {
        self.state = ActorState::Connecting;
        tracing::debug!("connecting to {}", self.opts.url);

        // TCP + TLS + WS open
        let ws_result =
            tokio::time::timeout(self.opts.connect_timeout, connect_async(&self.opts.url)).await;

        let (ws_stream, _response) = match ws_result {
            Ok(Ok((ws, resp))) => (ws, resp),
            Ok(Err(e)) => {
                let err = SdkError::WsConnect(e.to_string());
                tracing::warn!("ws connect failed: {e}");
                self.handle_connect_failure(err).await;
                return;
            }
            Err(_) => {
                let err = SdkError::WsConnect("connect timeout".into());
                tracing::warn!("ws connect timeout");
                self.handle_connect_failure(err).await;
                return;
            }
        };

        let (sink, stream) = ws_stream.split();
        self.sink = Some(sink);
        self.stream = Some(stream);
        self.state = ActorState::Handshaking;

        // Wait for connect.challenge event
        if let Err(e) = self.do_handshake().await {
            tracing::warn!("handshake failed: {e}");
            self.cleanup_ws();
            self.handle_connect_failure(e).await;
        }
    }

    /// Perform the handshake: wait for challenge, send connect, wait for hello-ok.
    async fn do_handshake(&mut self) -> Result<(), SdkError> {
        let stream = self.stream.as_mut().ok_or_else(|| {
            SdkError::HandshakeFailed("no ws stream".into())
        })?;

        // Wait for connect.challenge with timeout
        let challenge_timeout = Duration::from_millis(CHALLENGE_TIMEOUT_MS);
        let mut nonce = String::new();

        let msg = tokio::time::timeout(challenge_timeout, stream.next()).await;
        match msg {
            Ok(Some(Ok(Message::Text(text)))) => {
                if let Ok(frame) = serde_json::from_str::<InboundFrame>(&text) {
                    if let InboundFrame::Event(evt) = frame {
                        if evt.event == "connect.challenge" {
                            if let Some(payload) = &evt.payload {
                                nonce = payload
                                    .get("nonce")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string();
                            }
                        }
                    }
                }
            }
            Ok(Some(Ok(_))) => {
                // Non-text message during handshake
            }
            Ok(Some(Err(e))) => {
                return Err(SdkError::HandshakeFailed(format!(
                    "ws error during challenge: {e}"
                )));
            }
            Ok(None) => {
                return Err(SdkError::HandshakeFailed(
                    "ws closed before challenge".into(),
                ));
            }
            Err(_) => {
                // Challenge timeout — proceed without nonce (some older Gateways)
                tracing::debug!("challenge timeout, proceeding without nonce");
            }
        }

        // Build auth payload
        let auth_payload = {
            let auth = &self.opts.auth;
            if auth.token.is_some() || auth.password.is_some() || self.device_token.is_some() {
                Some(AuthPayload {
                    token: auth.token.clone(),
                    password: auth.password.clone(),
                    device_token: self.device_token.clone(),
                })
            } else {
                None
            }
        };

        // Build device auth if identity is available
        let device_auth = if let Some(ref identity) = self.opts.device_identity {
            let signed_at = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            let token_for_sig = self
                .opts
                .auth
                .token
                .as_deref()
                .unwrap_or("");
            let payload = identity.build_signature_payload_v3(
                CLIENT_ID,
                CLIENT_MODE,
                DEFAULT_ROLE,
                DEFAULT_SCOPES,
                signed_at,
                token_for_sig,
                &nonce,
                std::env::consts::OS,
                "",
            );
            let signature = identity.sign(&payload);
            Some(DeviceAuthParams {
                id: identity.device_id.clone(),
                public_key: identity.public_key_base64url(),
                signature,
                signed_at,
                nonce: nonce.clone(),
            })
        } else {
            None
        };

        // Send connect request
        let connect_id = uuid::Uuid::new_v4().to_string();
        let connect_params = ConnectParams::build(auth_payload, device_auth);
        let frame = RequestFrame::new(
            &connect_id,
            "connect",
            Some(serde_json::to_value(&connect_params).map_err(|e| {
                SdkError::HandshakeFailed(format!("serialize connect params: {e}"))
            })?),
        );

        let frame_json = serde_json::to_string(&frame).map_err(|e| {
            SdkError::HandshakeFailed(format!("serialize frame: {e}"))
        })?;

        let sink = self.sink.as_mut().ok_or_else(|| {
            SdkError::HandshakeFailed("no ws sink".into())
        })?;
        sink.send(Message::Text(frame_json.into())).await.map_err(|e| {
            SdkError::HandshakeFailed(format!("send connect: {e}"))
        })?;

        // Wait for hello-ok response
        let stream = self.stream.as_mut().ok_or_else(|| {
            SdkError::HandshakeFailed("no ws stream".into())
        })?;

        let hello_timeout = self.opts.connect_timeout;
        let msg = tokio::time::timeout(hello_timeout, stream.next()).await;
        match msg {
            Ok(Some(Ok(Message::Text(text)))) => {
                let inbound: InboundFrame = serde_json::from_str(&text).map_err(|e| {
                    SdkError::HandshakeFailed(format!("parse hello-ok: {e}"))
                })?;
                match inbound {
                    InboundFrame::Response(res) => {
                        if res.id != connect_id {
                            return Err(SdkError::HandshakeFailed(
                                "hello-ok id mismatch".into(),
                            ));
                        }
                        if !res.ok {
                            let err = res.error.unwrap_or_default();
                            return Err(SdkError::HandshakeFailed(format!(
                                "{}: {}",
                                err.code, err.message
                            )));
                        }
                        // Parse hello-ok payload
                        if let Some(payload) = res.payload {
                            let hello: HelloOk =
                                serde_json::from_value(payload).unwrap_or_default();
                            // Cache device token for reconnection
                            if let Some(ref auth) = hello.auth {
                                if let Some(ref dt) = auth.device_token {
                                    self.device_token = Some(dt.clone());
                                }
                            }
                            // Store server info
                            if let Some(info) = hello.server {
                                *self.server_info.write().await = Some(info);
                            }
                        }
                        // Handshake complete
                        self.state = ActorState::Connected;
                        self.connected.store(true, Ordering::Relaxed);
                        self.backoff.reset();
                        tracing::info!("gateway connected");

                        // Notify connect responder
                        if let Some(tx) = self.connect_responder.take() {
                            let _ = tx.send(Ok(()));
                        }
                        Ok(())
                    }
                    InboundFrame::Event(_) => {
                        // Unexpected event during handshake — ignore and retry
                        Err(SdkError::HandshakeFailed(
                            "unexpected event during handshake".into(),
                        ))
                    }
                }
            }
            Ok(Some(Ok(_))) => Err(SdkError::HandshakeFailed(
                "non-text message during handshake".into(),
            )),
            Ok(Some(Err(e))) => Err(SdkError::HandshakeFailed(format!(
                "ws error during handshake: {e}"
            ))),
            Ok(None) => Err(SdkError::HandshakeFailed(
                "ws closed during handshake".into(),
            )),
            Err(_) => Err(SdkError::HandshakeFailed(
                "handshake timeout".into(),
            )),
        }
    }

    /// Handle a connect/handshake failure.
    async fn handle_connect_failure(&mut self, err: SdkError) {
        if let Some(tx) = self.connect_responder.take() {
            // First connect attempt — report error back to caller
            let _ = tx.send(Err(err));
            self.state = ActorState::Disconnected;
        } else if self.opts.auto_reconnect {
            // Reconnection attempt — schedule retry
            self.state = ActorState::Reconnecting;
        } else {
            self.state = ActorState::Disconnected;
        }
    }

    /// Main loop for the Connected state.
    async fn run_connected(&mut self) {
        // Tick timeout: 2x the server tick interval (default 30s × 2 = 60s)
        let tick_timeout = Duration::from_secs(60);
        let mut tick_deadline = tokio::time::Instant::now() + tick_timeout;

        loop {
            let stream = match self.stream.as_mut() {
                Some(s) => s,
                None => {
                    self.transition_to_reconnect();
                    return;
                }
            };

            tokio::select! {
                // Handle commands from GatewayClient
                cmd = self.cmd_rx.recv() => {
                    match cmd {
                        Some(ActorCommand::Connect { respond_to }) => {
                            // Already connected
                            let _ = respond_to.send(Ok(()));
                        }
                        Some(ActorCommand::Request { id, method, params, respond_to }) => {
                            self.handle_request(id, method, params, respond_to).await;
                        }
                        Some(ActorCommand::Notify { method, params }) => {
                            self.handle_notify(method, params).await;
                        }
                        Some(ActorCommand::Shutdown) | None => {
                            self.cleanup_ws();
                            self.state = ActorState::Disconnected;
                            return;
                        }
                    }
                }
                // Handle incoming WS messages
                msg = stream.next() => {
                    match msg {
                        Some(Ok(Message::Text(text))) => {
                            if let Ok(frame) = serde_json::from_str::<InboundFrame>(&text) {
                                match frame {
                                    InboundFrame::Response(res) => {
                                        self.handle_response(res);
                                    }
                                    InboundFrame::Event(evt) => {
                                        if evt.event == "tick" {
                                            tick_deadline = tokio::time::Instant::now() + tick_timeout;
                                        }
                                        // Broadcast event (ignore if no receivers)
                                        let _ = self.event_tx.send(evt);
                                    }
                                }
                            }
                        }
                        Some(Ok(Message::Ping(data))) => {
                            if let Some(ref mut sink) = self.sink {
                                let _ = sink.send(Message::Pong(data)).await;
                            }
                        }
                        Some(Ok(Message::Close(_))) | None => {
                            tracing::info!("ws connection closed");
                            self.transition_to_reconnect();
                            return;
                        }
                        Some(Err(e)) => {
                            tracing::warn!("ws error: {e}");
                            self.transition_to_reconnect();
                            return;
                        }
                        Some(Ok(_)) => {} // Binary, Pong, Frame — ignore
                    }
                }
                // Tick timeout watchdog
                _ = tokio::time::sleep_until(tick_deadline) => {
                    tracing::warn!("tick timeout, closing connection");
                    self.transition_to_reconnect();
                    return;
                }
            }
        }
    }

    /// Send an RPC request frame.
    async fn handle_request(
        &mut self,
        id: String,
        method: String,
        params: serde_json::Value,
        respond_to: oneshot::Sender<Result<serde_json::Value, SdkError>>,
    ) {
        let frame = RequestFrame::new(&id, &method, Some(params));
        let json = match serde_json::to_string(&frame) {
            Ok(j) => j,
            Err(e) => {
                let _ = respond_to.send(Err(SdkError::Parse(e.to_string())));
                return;
            }
        };

        // Register pending before sending
        self.pending.insert(id.clone(), respond_to);

        if let Some(ref mut sink) = self.sink {
            if let Err(e) = sink.send(Message::Text(json.into())).await {
                // Send failed — resolve pending with error
                if let Some((_, tx)) = self.pending.remove(&id) {
                    let _ = tx.send(Err(SdkError::Disconnected {
                        reason: e.to_string(),
                    }));
                }
            }
        } else if let Some((_, tx)) = self.pending.remove(&id) {
            let _ = tx.send(Err(SdkError::GatewayNotConnected));
        }
    }

    /// Send a notification frame (no response expected).
    async fn handle_notify(&mut self, method: String, params: serde_json::Value) {
        let frame = RequestFrame::new(uuid::Uuid::new_v4().to_string(), &method, Some(params));
        if let Ok(json) = serde_json::to_string(&frame) {
            if let Some(ref mut sink) = self.sink {
                let _ = sink.send(Message::Text(json.into())).await;
            }
        }
    }

    /// Handle an inbound response frame.
    fn handle_response(&self, res: crate::ws::protocol::ResponseFrame) {
        if let Some((_, tx)) = self.pending.remove(&res.id) {
            if res.ok {
                let _ = tx.send(Ok(res.payload.unwrap_or(serde_json::Value::Null)));
            } else {
                let err = res.error.unwrap_or_default();
                let _ = tx.send(Err(SdkError::RpcError {
                    code: err.code,
                    message: err.message,
                    details: err.details,
                    retryable: err.retryable,
                }));
            }
        }
    }

    /// Transition to the Reconnecting state.
    fn transition_to_reconnect(&mut self) {
        self.cleanup_ws();
        self.connected.store(false, Ordering::Relaxed);
        self.flush_pending(SdkError::Disconnected {
            reason: "connection lost".into(),
        });
        if self.opts.auto_reconnect {
            self.state = ActorState::Reconnecting;
        } else {
            self.state = ActorState::Disconnected;
        }
    }

    /// Close and drop the WS connection.
    fn cleanup_ws(&mut self) {
        self.sink = None;
        self.stream = None;
    }

    /// Fail all pending requests with the given error.
    fn flush_pending(&self, error: SdkError) {
        let keys: Vec<String> = self.pending.iter().map(|e| e.key().clone()).collect();
        for key in keys {
            if let Some((_, tx)) = self.pending.remove(&key) {
                let _ = tx.send(Err(error.clone()));
            }
        }
    }
}

impl Default for HelloOk {
    fn default() -> Self {
        Self {
            protocol: None,
            server: None,
            features: None,
            snapshot: None,
            canvas_host_url: None,
            auth: None,
            policy: None,
        }
    }
}
