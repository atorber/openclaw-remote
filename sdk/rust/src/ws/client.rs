use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use dashmap::DashMap;
use serde::de::DeserializeOwned;
use serde::Serialize;
use tokio::sync::{broadcast, mpsc, oneshot};

use crate::error::SdkError;
use crate::ws::actor::{ActorCommand, ConnectOptions, WsActor};
use crate::ws::auth::ServerInfo;
use crate::ws::events::filtered_event_stream;
use crate::ws::protocol::EventFrame;
use crate::ws::traits::GatewayRpc;

/// Broadcast channel capacity for event distribution.
const EVENT_CHANNEL_CAPACITY: usize = 256;

/// Command channel capacity.
const CMD_CHANNEL_CAPACITY: usize = 64;

/// Client for the OpenClaw Gateway WebSocket connection.
///
/// Internally spawns a `WsActor` tokio task that exclusively owns the WS connection.
/// All communication happens through mpsc/oneshot channels.
pub struct GatewayClient {
    cmd_tx: mpsc::Sender<ActorCommand>,
    event_tx: broadcast::Sender<EventFrame>,
    server_info: Arc<tokio::sync::RwLock<Option<ServerInfo>>>,
    connected: Arc<AtomicBool>,
    opts: ConnectOptions,
    _actor_handle: tokio::task::JoinHandle<()>,
}

impl GatewayClient {
    /// Create a new client (does NOT connect immediately).
    ///
    /// The actor is spawned in `Disconnected` state. Call `connect()` to initiate
    /// the WebSocket connection and handshake.
    pub fn new(opts: ConnectOptions) -> Self {
        let (cmd_tx, cmd_rx) = mpsc::channel(CMD_CHANNEL_CAPACITY);
        let (event_tx, _) = broadcast::channel(EVENT_CHANNEL_CAPACITY);
        let pending = Arc::new(DashMap::new());
        let server_info = Arc::new(tokio::sync::RwLock::new(None));
        let connected = Arc::new(AtomicBool::new(false));

        let actor = WsActor::new(
            opts.clone(),
            cmd_rx,
            event_tx.clone(),
            pending,
            server_info.clone(),
            connected.clone(),
        );

        let handle = tokio::spawn(actor.run());

        Self {
            cmd_tx,
            event_tx,
            server_info,
            connected,
            opts,
            _actor_handle: handle,
        }
    }

    /// Initiate connection to the Gateway (idempotent if already connected).
    pub async fn connect(&self) -> Result<(), SdkError> {
        if self.connected.load(Ordering::Relaxed) {
            return Ok(());
        }
        let (tx, rx) = oneshot::channel();
        self.cmd_tx
            .send(ActorCommand::Connect { respond_to: tx })
            .await
            .map_err(|_| SdkError::Disconnected {
                reason: "actor gone".into(),
            })?;
        rx.await.map_err(|_| SdkError::Disconnected {
            reason: "actor gone".into(),
        })?
    }

    /// Disconnect from the Gateway.
    pub async fn disconnect(&self) {
        let _ = self.cmd_tx.send(ActorCommand::Shutdown).await;
    }

    /// Get the server info from the last successful handshake.
    pub async fn server_info(&self) -> Option<ServerInfo> {
        self.server_info.read().await.clone()
    }

    /// Get the connect options.
    pub fn options(&self) -> &ConnectOptions {
        &self.opts
    }
}

#[async_trait]
impl GatewayRpc for GatewayClient {
    async fn request_raw(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, SdkError> {
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();

        self.cmd_tx
            .send(ActorCommand::Request {
                id,
                method: method.into(),
                params,
                respond_to: tx,
            })
            .await
            .map_err(|_| SdkError::Disconnected {
                reason: "actor gone".into(),
            })?;

        match tokio::time::timeout(self.opts.request_timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(SdkError::Disconnected {
                reason: "actor dropped response".into(),
            }),
            Err(_) => Err(SdkError::RequestTimeout(self.opts.request_timeout)),
        }
    }

    async fn request<T: DeserializeOwned + Send>(
        &self,
        method: &str,
        params: impl Serialize + Send,
    ) -> Result<T, SdkError> {
        let value = self
            .request_raw(method, serde_json::to_value(params)?)
            .await?;
        Ok(serde_json::from_value(value)?)
    }

    async fn notify(
        &self,
        method: &str,
        params: impl Serialize + Send,
    ) -> Result<(), SdkError> {
        let params = serde_json::to_value(params)?;
        self.cmd_tx
            .send(ActorCommand::Notify {
                method: method.into(),
                params,
            })
            .await
            .map_err(|_| SdkError::Disconnected {
                reason: "actor gone".into(),
            })?;
        Ok(())
    }

    fn subscribe_events(&self) -> broadcast::Receiver<EventFrame> {
        self.event_tx.subscribe()
    }

    fn subscribe(
        &self,
        event_name: &str,
    ) -> Pin<Box<dyn futures_util::Stream<Item = EventFrame> + Send>> {
        filtered_event_stream(&self.event_tx, event_name)
    }

    fn is_connected(&self) -> bool {
        self.connected.load(Ordering::Relaxed)
    }
}

// Re-export ConnectOptions and DisconnectPolicy at the client module level
pub use crate::ws::actor::{ConnectOptions as ConnectOpts, DisconnectPolicy as DisconnectPol};
