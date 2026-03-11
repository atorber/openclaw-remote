# OpenClaw Rust SDK 详细设计文档

> 基于 `DESIGN.v2.md` 产品设计方案，合并 `REVIEW.v2.md` 全部评审意见。本文档面向实施，包含完整的接口定义、状态机、错误处理、测试策略。

## 1. Cargo 工程配置

```toml
[package]
name = "openclaw-sdk"
version = "0.1.0"
edition = "2021"
description = "Rust SDK for OpenClaw Gateway (WS RPC + CLI)"
license = "MIT"

[features]
default = ["ws", "cli"]
ws = ["dep:tokio-tungstenite", "dep:futures-util", "dep:dashmap"]
cli = ["dep:which"]

[dependencies]
# WS 层（feature-gated）
tokio-tungstenite = { version = "0.24", features = ["rustls-tls-webpki-roots"], optional = true }
futures-util = { version = "0.3", optional = true }
dashmap = { version = "6", optional = true }

# 核心
tokio = { version = "1", features = ["process", "time", "sync", "macros", "rt-multi-thread"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
thiserror = "2"
tracing = "0.1"
uuid = { version = "1", features = ["v4"] }
async-trait = "0.1"

# CLI 层（feature-gated）
which = { version = "7", optional = true }

[dev-dependencies]
tokio = { version = "1", features = ["full"] }
tokio-test = "0.4"
mockall = "0.13"
```

## 2. 目录结构（最终版）

```
src/
├── lib.rs                          # re-export 公共 API
├── error.rs                        # SdkError
│
├── ws/                             # ===== WS 直连层（feature = "ws"）=====
│   ├── mod.rs
│   ├── client.rs                   # GatewayClient 实现
│   ├── actor.rs                    # WsActor — 独占 WS 读写的 tokio task
│   ├── protocol.rs                 # RequestFrame / ResponseFrame / EventFrame
│   ├── handshake.rs                # 握手状态机（challenge → connect → hello-ok）
│   ├── reconnect.rs                # 重连策略（指数退避）
│   ├── auth.rs                     # AuthConfig + 凭据解析链
│   ├── events.rs                   # 事件 broadcast + 过滤 Stream
│   ├── traits.rs                   # GatewayRpc trait（可 mock）
│   │
│   └── methods/                    # 类型化 RPC 方法封装
│       ├── mod.rs
│       ├── agent.rs                # agent, agent.wait
│       ├── message.rs              # send, poll（跨频道出站消息）
│       ├── chat.rs                 # chat.send, chat.history, chat.abort（webchat 会话）
│       ├── channels.rs             # channels.status, channels.logout
│       ├── config.rs               # config.get/set/apply/patch/schema
│       ├── models.rs               # models.list
│       ├── sessions.rs             # sessions.list/get/patch/delete/compact/usage
│       ├── agents.rs               # agents.list/create/update/delete/files.*
│       ├── devices.rs              # device.pair.*/device.token.*
│       ├── cron.rs                 # cron.list/status/add/update/remove/run/runs
│       ├── nodes.rs                # node.list/describe/invoke/pair.*
│       ├── skills.rs               # skills.status/install/update
│       ├── browser.rs              # browser.request
│       ├── logs.rs                 # logs.tail
│       ├── status.rs               # health, status, system-presence, last-heartbeat
│       ├── system.rs               # system-event, set-heartbeats
│       ├── approvals.rs            # exec.approval.*/exec.approvals.*
│       ├── secrets.rs              # secrets.reload/resolve
│       ├── usage.rs                # usage.status/cost, sessions.usage.*
│       └── update_rpc.rs           # update.run
│
├── cli/                            # ===== CLI spawn 层（feature = "cli"）=====
│   ├── mod.rs
│   ├── executor.rs                 # CliExecutor 实现
│   ├── traits.rs                   # CliExec trait（可 mock）
│   └── commands/
│       ├── mod.rs
│       ├── setup.rs
│       ├── onboard.rs
│       ├── configure.rs
│       ├── doctor.rs
│       ├── update.rs
│       ├── backup.rs
│       ├── reset.rs
│       ├── uninstall.rs
│       ├── completion.rs
│       ├── qr.rs
│       ├── channels_local.rs       # channels add/remove/login/logout
│       └── models_local.rs         # models scan/auth
│
├── types/                          # ===== 共享类型 =====
│   ├── mod.rs
│   ├── channel.rs
│   ├── agent.rs
│   ├── message.rs
│   ├── model.rs
│   ├── gateway.rs
│   ├── session.rs
│   ├── device.rs
│   ├── cron.rs
│   ├── node.rs
│   ├── config.rs
│   ├── event.rs
│   ├── approval.rs
│   ├── usage.rs
│   └── common.rs
│
└── sdk.rs                          # OpenClawSdk 统一入口
```

## 3. WS 层：Actor 模型详细设计

### 3.1 总体结构

v2 评审指出 `Arc<Mutex<ClientInner>>` 定义不明且有锁竞争风险。最终采用 **actor 模型**：一个独立 tokio task 独占 WS 读写，外部通过 channel 与之通信。

```
                          ┌─────────────────────────────────┐
                          │          WsActor (tokio task)    │
 GatewayClient            │                                 │
┌──────────────┐  cmd_tx  │  ┌───────┐      ┌───────────┐  │
│              │ ────────→│  │ cmd_rx │ ───→ │ WS sink   │──│──→ Gateway
│  request()   │          │  └───────┘      └───────────┘  │
│  notify()    │  res:    │                                 │
│  disconnect()│ ←────────│  ┌───────────┐  ┌───────────┐  │
│              │ oneshot   │  │ event_tx  │ ←│ WS stream │←─│─── Gateway
│  events()   │ ←─────────│  │(broadcast)│  └───────────┘  │
│              │ broadcast │  └───────────┘                  │
└──────────────┘          │  ┌───────────┐                  │
                          │  │ pending   │ (DashMap)        │
                          │  └───────────┘                  │
                          └─────────────────────────────────┘
```

### 3.2 内部消息类型

```rust
/// GatewayClient → WsActor 的命令
enum ActorCommand {
    /// 发送 RPC 请求
    Request {
        id: String,
        method: String,
        params: serde_json::Value,
        respond_to: oneshot::Sender<Result<serde_json::Value, SdkError>>,
    },
    /// 发送 fire-and-forget 通知
    Notify {
        method: String,
        params: serde_json::Value,
    },
    /// 主动断开
    Shutdown,
}
```

### 3.3 WsActor 状态机

```
                  ┌──────────────┐
                  │ Disconnected │ ←──────────────────────────┐
                  └──────┬───────┘                            │
                         │ connect_gateway() 调用              │
                         ▼                                    │
                  ┌──────────────┐                            │
                  │ Connecting   │ ── 超时/失败 ──→ 等待退避 ──┘
                  └──────┬───────┘
                         │ WS open 成功
                         ▼
                  ┌──────────────┐
                  │ Handshaking  │ ── 握手失败 ──→ 等待退避 ──┘
                  │ (challenge → │
                  │  connect →   │
                  │  hello-ok)   │
                  └──────┬───────┘
                         │ hello-ok 收到
                         ▼
                  ┌──────────────┐
             ┌──→ │   Connected  │ ←── 重连成功 ──┐
             │    └──────┬───────┘                │
  正常收发帧  │           │ WS close / error       │
             │           ▼                        │
             │    ┌──────────────┐                │
             └─── │ Reconnecting │ ── 退避等待 ───┘
                  │ (auto_recon- │ ── 禁用重连 ──→ Disconnected
                  │  nect=true)  │
                  └──────────────┘
```

### 3.4 WsActor 实现

```rust
struct WsActor {
    opts: ConnectOptions,
    cmd_rx: mpsc::Receiver<ActorCommand>,
    event_tx: broadcast::Sender<EventFrame>,
    pending: Arc<DashMap<String, oneshot::Sender<Result<serde_json::Value, SdkError>>>>,
    state: ActorState,
    server_info: Arc<tokio::sync::RwLock<Option<ServerInfo>>>,
    backoff: ExponentialBackoff,
}

enum ActorState {
    Disconnected,
    Connecting,
    Handshaking,
    Connected,
    Reconnecting,
}

struct ExponentialBackoff {
    current: Duration,
    min: Duration,     // 1s
    max: Duration,     // 30s
    factor: f64,       // 2.0
}

impl ExponentialBackoff {
    fn next_delay(&mut self) -> Duration {
        let delay = self.current;
        self.current = (self.current.mul_f64(self.factor)).min(self.max);
        delay
    }
    fn reset(&mut self) {
        self.current = self.min;
    }
}

impl WsActor {
    async fn run(mut self) {
        loop {
            tokio::select! {
                // 处理外部命令
                Some(cmd) = self.cmd_rx.recv() => {
                    match cmd {
                        ActorCommand::Shutdown => break,
                        ActorCommand::Request { id, method, params, respond_to } => {
                            self.handle_request(id, method, params, respond_to).await;
                        }
                        ActorCommand::Notify { method, params } => {
                            self.handle_notify(method, params).await;
                        }
                    }
                }
                // 处理 WS 入站消息（Connected 状态下）
                Some(msg) = self.next_ws_message() => {
                    self.handle_ws_message(msg).await;
                }
                // cmd_rx 关闭 → 退出
                else => break,
            }
        }
        // 清理：flush pending requests
        self.flush_pending(SdkError::Disconnected {
            reason: "actor shutdown".into(),
        });
    }

    async fn handle_request(
        &mut self,
        id: String,
        method: String,
        params: serde_json::Value,
        respond_to: oneshot::Sender<Result<serde_json::Value, SdkError>>,
    ) {
        if !matches!(self.state, ActorState::Connected) {
            let _ = respond_to.send(Err(SdkError::GatewayNotConnected));
            return;
        }
        self.pending.insert(id.clone(), respond_to);
        let frame = RequestFrame {
            frame_type: "req",
            id,
            method,
            params: Some(params),
        };
        if let Err(e) = self.send_frame(&frame).await {
            // 发送失败：从 pending 中取出并回复错误
            if let Some((_, tx)) = self.pending.remove(&frame.id) {
                let _ = tx.send(Err(e));
            }
        }
    }

    async fn handle_ws_message(&mut self, frame: InboundFrame) {
        match frame {
            InboundFrame::Response(res) => {
                if let Some((_, tx)) = self.pending.remove(&res.id) {
                    if res.ok {
                        let _ = tx.send(Ok(res.payload.unwrap_or(serde_json::Value::Null)));
                    } else {
                        let err = res.error.unwrap_or_default();
                        let _ = tx.send(Err(SdkError::RpcError {
                            code: err.code,
                            message: err.message,
                            details: err.details,
                        }));
                    }
                }
            }
            InboundFrame::Event(evt) => {
                // connect.challenge 在 Handshaking 状态特殊处理
                if evt.event == "connect.challenge" && matches!(self.state, ActorState::Handshaking) {
                    self.handle_challenge(&evt).await;
                    return;
                }
                // 广播给所有订阅者（忽略无接收者的情况）
                let _ = self.event_tx.send(evt);
            }
        }
    }

    fn flush_pending(&self, error: SdkError) {
        for entry in self.pending.iter() {
            // DashMap 不支持 drain，逐个移除
        }
        let keys: Vec<String> = self.pending.iter().map(|e| e.key().clone()).collect();
        for key in keys {
            if let Some((_, tx)) = self.pending.remove(&key) {
                let _ = tx.send(Err(error.clone()));
            }
        }
    }
}
```

### 3.5 握手流程实现

```rust
// ws/handshake.rs

const CHALLENGE_TIMEOUT: Duration = Duration::from_millis(750);
const PROTOCOL_VERSION: u32 = 3;

#[derive(Serialize)]
struct ConnectParams {
    #[serde(rename = "minProtocol")]
    min_protocol: u32,
    #[serde(rename = "maxProtocol")]
    max_protocol: u32,
    client: ClientInfo,
    role: &'static str,
    scopes: Vec<&'static str>,
    caps: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    auth: Option<AuthPayload>,
}

#[derive(Serialize)]
struct ClientInfo {
    id: &'static str,
    version: &'static str,
    platform: &'static str,
    mode: &'static str,
    #[serde(rename = "instanceId")]
    instance_id: String,
}

#[derive(Serialize)]
struct AuthPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    password: Option<String>,
}

impl WsActor {
    /// WS open 成功后调用，启动握手
    async fn begin_handshake(&mut self) {
        self.state = ActorState::Handshaking;
        // 启动 challenge 超时定时器
        // 如果 750ms 内收到 connect.challenge event → handle_challenge 触发
        // 否则定时器到期 → 直接发送 connect 请求
        let timeout = tokio::time::sleep(CHALLENGE_TIMEOUT);
        tokio::pin!(timeout);
        // 超时后兜底发送
        tokio::select! {
            _ = &mut timeout => {
                self.send_connect_request().await;
            }
            // challenge 在 handle_ws_message 中处理，会调用 handle_challenge
        }
    }

    async fn handle_challenge(&mut self, evt: &EventFrame) {
        // 提取 nonce（当前实现中未使用 nonce 做签名，仅作为 challenge 触发信号）
        self.send_connect_request().await;
    }

    async fn send_connect_request(&mut self) {
        let connect_id = uuid::Uuid::new_v4().to_string();
        let params = ConnectParams {
            min_protocol: PROTOCOL_VERSION,
            max_protocol: PROTOCOL_VERSION,
            client: ClientInfo {
                id: "openclaw-rust-sdk",
                version: env!("CARGO_PKG_VERSION"),
                platform: "rust",
                mode: "ui",
                instance_id: uuid::Uuid::new_v4().to_string(),
            },
            role: "operator",
            scopes: vec!["operator.admin", "operator.approvals", "operator.pairing"],
            caps: vec![],
            auth: self.build_auth_payload(),
        };

        // 注册 pending 来接收 hello-ok 响应
        let (tx, rx) = oneshot::channel();
        self.pending.insert(connect_id.clone(), tx);

        let frame = RequestFrame {
            frame_type: "req",
            id: connect_id,
            method: "connect".into(),
            params: Some(serde_json::to_value(&params).unwrap()),
        };
        self.send_frame(&frame).await.ok();

        // 等待 hello-ok
        match tokio::time::timeout(self.opts.connect_timeout, rx).await {
            Ok(Ok(Ok(payload))) => {
                // 解析 server info
                self.parse_hello_ok(&payload).await;
                self.state = ActorState::Connected;
                self.backoff.reset();
                tracing::info!("gateway connected");
            }
            _ => {
                tracing::warn!("handshake failed, will reconnect");
                self.schedule_reconnect().await;
            }
        }
    }
}
```

### 3.6 认证凭据解析链

```rust
// ws/auth.rs

impl AuthConfig {
    /// 凭据解析优先级：显式传入 > 环境变量 > 配置文件
    pub fn resolve(explicit: Option<AuthConfig>) -> Self {
        if let Some(auth) = explicit {
            if auth.token.is_some() || auth.password.is_some() {
                return auth;
            }
        }

        // 环境变量
        let token = std::env::var("OPENCLAW_GATEWAY_TOKEN").ok();
        let password = std::env::var("OPENCLAW_GATEWAY_PASSWORD").ok();
        if token.is_some() || password.is_some() {
            return Self { token, password };
        }

        // 配置文件 ~/.openclaw/openclaw.json → gateway.auth.*
        if let Some(auth) = Self::from_config_file() {
            return auth;
        }

        Self { token: None, password: None }
    }

    fn from_config_file() -> Option<Self> {
        let home = dirs::home_dir()?;
        let config_path = std::env::var("OPENCLAW_CONFIG_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home.join(".openclaw").join("openclaw.json"));

        let content = std::fs::read_to_string(&config_path).ok()?;
        let config: serde_json::Value = serde_json::from_str(&content).ok()?;
        let gateway = config.get("gateway")?.get("auth")?;

        Some(Self {
            token: gateway.get("token").and_then(|v| v.as_str()).map(String::from),
            password: gateway.get("password").and_then(|v| v.as_str()).map(String::from),
        })
    }
}
```

## 4. GatewayClient 公开接口

### 4.1 trait 抽象

```rust
// ws/traits.rs

#[async_trait]
pub trait GatewayRpc: Send + Sync {
    /// 发送 RPC 请求，返回原始 JSON payload
    async fn request_raw(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, SdkError>;

    /// 发送 RPC 请求，返回类型化结果
    async fn request<T: DeserializeOwned + Send>(
        &self,
        method: &str,
        params: impl Serialize + Send,
    ) -> Result<T, SdkError> {
        let value = self.request_raw(method, serde_json::to_value(params)?).await?;
        Ok(serde_json::from_value(value)?)
    }

    /// fire-and-forget
    async fn notify(&self, method: &str, params: impl Serialize + Send) -> Result<(), SdkError>;

    /// 订阅全部事件
    fn subscribe_events(&self) -> broadcast::Receiver<EventFrame>;

    /// 订阅指定事件名
    fn subscribe(&self, event_name: &str) -> Pin<Box<dyn Stream<Item = EventFrame> + Send>>;

    /// 连接状态
    fn is_connected(&self) -> bool;
}
```

### 4.2 GatewayClient 实现

```rust
// ws/client.rs

const EVENT_CHANNEL_CAPACITY: usize = 256;

pub struct GatewayClient {
    cmd_tx: mpsc::Sender<ActorCommand>,
    event_tx: broadcast::Sender<EventFrame>,
    server_info: Arc<tokio::sync::RwLock<Option<ServerInfo>>>,
    connected: Arc<AtomicBool>,
    opts: ConnectOptions,
    _actor_handle: tokio::task::JoinHandle<()>,
}

pub struct ConnectOptions {
    pub url: String,
    pub auth: AuthConfig,
    pub connect_timeout: Duration,           // 默认 10s
    pub request_timeout: Duration,           // 默认 60s
    pub auto_reconnect: bool,                // 默认 true
    pub disconnect_policy: DisconnectPolicy, // 默认 FailFast
}

#[derive(Debug, Clone)]
pub enum DisconnectPolicy {
    /// 未连接时立即返回 GatewayNotConnected
    FailFast,
    /// 排队等待重连，超时后失败
    WaitReconnect(Duration),
}

impl Default for ConnectOptions {
    fn default() -> Self {
        Self {
            url: "ws://127.0.0.1:18789".into(),
            auth: AuthConfig::resolve(None),
            connect_timeout: Duration::from_secs(10),
            request_timeout: Duration::from_secs(60),
            auto_reconnect: true,
            disconnect_policy: DisconnectPolicy::FailFast,
        }
    }
}

impl GatewayClient {
    /// 创建客户端（不立即连接）
    pub fn new(opts: ConnectOptions) -> Self {
        let (cmd_tx, cmd_rx) = mpsc::channel(64);
        let (event_tx, _) = broadcast::channel(EVENT_CHANNEL_CAPACITY);
        let pending = Arc::new(DashMap::new());
        let server_info = Arc::new(tokio::sync::RwLock::new(None));
        let connected = Arc::new(AtomicBool::new(false));

        let actor = WsActor {
            opts: opts.clone(),
            cmd_rx,
            event_tx: event_tx.clone(),
            pending,
            state: ActorState::Disconnected,
            server_info: server_info.clone(),
            connected: connected.clone(),
            backoff: ExponentialBackoff::new(
                Duration::from_secs(1),
                Duration::from_secs(30),
                2.0,
            ),
        };

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

    /// 触发连接（幂等，已连接时无操作）
    pub async fn connect(&self) -> Result<(), SdkError> {
        if self.connected.load(Ordering::Relaxed) {
            return Ok(());
        }
        let (tx, rx) = oneshot::channel();
        self.cmd_tx.send(ActorCommand::Connect { respond_to: tx }).await
            .map_err(|_| SdkError::Disconnected { reason: "actor gone".into() })?;
        rx.await.map_err(|_| SdkError::Disconnected { reason: "actor gone".into() })?
    }

    /// 主动断开
    pub async fn disconnect(&self) {
        let _ = self.cmd_tx.send(ActorCommand::Shutdown).await;
    }

    pub fn server_info(&self) -> Option<ServerInfo> {
        self.server_info.blocking_read().clone()
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

        self.cmd_tx.send(ActorCommand::Request {
            id,
            method: method.into(),
            params,
            respond_to: tx,
        }).await.map_err(|_| SdkError::Disconnected { reason: "actor gone".into() })?;

        match tokio::time::timeout(self.opts.request_timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(SdkError::Disconnected { reason: "actor dropped response".into() }),
            Err(_) => Err(SdkError::RequestTimeout(self.opts.request_timeout)),
        }
    }

    async fn notify(&self, method: &str, params: impl Serialize + Send) -> Result<(), SdkError> {
        let params = serde_json::to_value(params)?;
        self.cmd_tx.send(ActorCommand::Notify {
            method: method.into(),
            params,
        }).await.map_err(|_| SdkError::Disconnected { reason: "actor gone".into() })?;
        Ok(())
    }

    fn subscribe_events(&self) -> broadcast::Receiver<EventFrame> {
        self.event_tx.subscribe()
    }

    fn subscribe(&self, event_name: &str) -> Pin<Box<dyn Stream<Item = EventFrame> + Send>> {
        let name = event_name.to_string();
        let rx = self.event_tx.subscribe();
        Box::pin(BroadcastStream::new(rx).filter_map(move |result| {
            let name = name.clone();
            async move {
                match result {
                    Ok(evt) if evt.event == name => Some(evt),
                    Ok(_) => None,
                    Err(BroadcastStreamRecvError::Lagged(n)) => {
                        tracing::warn!("event subscriber lagged, missed {n} events");
                        None
                    }
                }
            }
        }))
    }

    fn is_connected(&self) -> bool {
        self.connected.load(Ordering::Relaxed)
    }
}
```

## 5. CLI 层详细设计

### 5.1 trait 抽象

```rust
// cli/traits.rs

#[async_trait]
pub trait CliExec: Send + Sync {
    /// 执行命令，解析 --json 输出
    async fn exec_json(&self, args: &[&str]) -> Result<serde_json::Value, SdkError>;

    /// 执行命令，返回原始输出
    async fn exec_raw(&self, args: &[&str]) -> Result<CommandOutput, SdkError>;
}

#[derive(Debug, Clone)]
pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}
```

### 5.2 CliExecutor 实现

```rust
// cli/executor.rs

const MIN_CLI_VERSION: &str = "2026.1.0";

const CLI_ENV_ALLOWLIST: &[&str] = &[
    "HOME", "PATH", "USER", "SHELL", "LANG", "TERM",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_GATEWAY_TOKEN",
    "OPENCLAW_GATEWAY_PASSWORD",
    "NO_COLOR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "NODE_OPTIONS",
];

pub struct CliExecutor {
    bin_path: PathBuf,
    global_flags: GlobalFlags,
    timeout: Duration,
    env: HashMap<String, String>,
}

#[derive(Debug, Clone, Default)]
pub struct GlobalFlags {
    pub dev: bool,
    pub profile: Option<String>,
}

#[derive(Debug, Clone)]
pub struct CliOptions {
    /// 显式指定 openclaw 路径（None = 从 PATH 查找）
    pub bin_path: Option<PathBuf>,
    pub global_flags: GlobalFlags,
    /// 命令超时（默认 120s）
    pub timeout: Duration,
    /// 是否校验最低版本（默认 true）
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
    pub fn new(opts: CliOptions) -> Result<Self, SdkError> {
        let bin_path = match opts.bin_path {
            Some(p) => p,
            None => which::which("openclaw")
                .map_err(|_| SdkError::BinaryNotFound("openclaw not in PATH".into()))?,
        };

        // 构建环境变量白名单
        let env: HashMap<String, String> = CLI_ENV_ALLOWLIST.iter()
            .filter_map(|key| std::env::var(key).ok().map(|val| (key.to_string(), val)))
            .collect();

        Ok(Self {
            bin_path,
            global_flags: opts.global_flags,
            timeout: opts.timeout,
            env,
        })
    }

    /// 获取 CLI 版本并校验
    pub async fn check_version(&self) -> Result<String, SdkError> {
        let output = self.exec_raw(&["--version"]).await?;
        let version = output.stdout.trim().to_string();
        // 解析并比较版本号
        // ...
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
            Ok(Err(e)) => Err(SdkError::Io(e)),
            Err(_) => Err(SdkError::CommandTimeout(self.timeout)),
        }
    }
}
```

## 6. OpenClawSdk 统一入口（两阶段初始化）

```rust
// sdk.rs

pub struct SdkOptions {
    pub gateway: ConnectOptions,
    pub cli: CliOptions,
}

pub struct OpenClawSdk<G: GatewayRpc = GatewayClient, C: CliExec = CliExecutor> {
    gateway: G,
    cli: C,
}

// 具体类型别名（非泛型用法）
pub type DefaultSdk = OpenClawSdk<GatewayClient, CliExecutor>;

impl DefaultSdk {
    /// 阶段一：同步创建，仅 CLI 层就绪，WS 层未连接
    pub fn new(opts: SdkOptions) -> Result<Self, SdkError> {
        let cli = CliExecutor::new(opts.cli)?;
        let gateway = GatewayClient::new(opts.gateway); // 不连接
        Ok(Self { gateway, cli })
    }

    /// 阶段二：异步连接 Gateway（幂等）
    pub async fn connect_gateway(&self) -> Result<(), SdkError> {
        self.gateway.connect().await
    }

    /// Gateway 是否已连接
    pub fn is_gateway_connected(&self) -> bool {
        self.gateway.is_connected()
    }

    /// 主动断开 Gateway
    pub async fn disconnect_gateway(&self) {
        self.gateway.disconnect().await
    }

    /// 事件订阅
    pub fn events(&self) -> broadcast::Receiver<EventFrame> {
        self.gateway.subscribe_events()
    }
}

impl<G: GatewayRpc, C: CliExec> OpenClawSdk<G, C> {
    // ---- WS 方法组 ----
    pub fn agent(&self) -> AgentMethods<'_, G>      { AgentMethods { rpc: &self.gateway } }
    pub fn message(&self) -> MessageMethods<'_, G>  { MessageMethods { rpc: &self.gateway } }
    pub fn chat(&self) -> ChatMethods<'_, G>        { ChatMethods { rpc: &self.gateway } }
    pub fn channels(&self) -> ChannelMethods<'_, G> { ChannelMethods { rpc: &self.gateway } }
    pub fn config(&self) -> ConfigMethods<'_, G>    { ConfigMethods { rpc: &self.gateway } }
    pub fn models(&self) -> ModelMethods<'_, G>     { ModelMethods { rpc: &self.gateway } }
    pub fn sessions(&self) -> SessionMethods<'_, G> { SessionMethods { rpc: &self.gateway } }
    pub fn cron(&self) -> CronMethods<'_, G>        { CronMethods { rpc: &self.gateway } }
    pub fn nodes(&self) -> NodeMethods<'_, G>       { NodeMethods { rpc: &self.gateway } }
    pub fn devices(&self) -> DeviceMethods<'_, G>   { DeviceMethods { rpc: &self.gateway } }
    pub fn browser(&self) -> BrowserMethods<'_, G>  { BrowserMethods { rpc: &self.gateway } }
    pub fn logs(&self) -> LogMethods<'_, G>         { LogMethods { rpc: &self.gateway } }
    pub fn status(&self) -> StatusMethods<'_, G>    { StatusMethods { rpc: &self.gateway } }
    pub fn approvals(&self) -> ApprovalMethods<'_, G> { ApprovalMethods { rpc: &self.gateway } }
    pub fn agents(&self) -> AgentsRpcMethods<'_, G> { AgentsRpcMethods { rpc: &self.gateway } }
    pub fn skills(&self) -> SkillMethods<'_, G>     { SkillMethods { rpc: &self.gateway } }
    pub fn usage(&self) -> UsageMethods<'_, G>      { UsageMethods { rpc: &self.gateway } }
    pub fn system(&self) -> SystemMethods<'_, G>    { SystemMethods { rpc: &self.gateway } }
    pub fn secrets(&self) -> SecretMethods<'_, G>   { SecretMethods { rpc: &self.gateway } }

    // ---- CLI 方法组 ----
    pub fn setup(&self) -> SetupCmd<'_, C>         { SetupCmd { cli: &self.cli } }
    pub fn doctor(&self) -> DoctorCmd<'_, C>       { DoctorCmd { cli: &self.cli } }
    pub fn update_cli(&self) -> UpdateCmd<'_, C>   { UpdateCmd { cli: &self.cli } }
    pub fn backup(&self) -> BackupCmd<'_, C>       { BackupCmd { cli: &self.cli } }
    pub fn reset(&self) -> ResetCmd<'_, C>         { ResetCmd { cli: &self.cli } }
    pub fn qr(&self) -> QrCmd<'_, C>              { QrCmd { cli: &self.cli } }
}
```

## 7. 错误类型（完整版）

```rust
// error.rs

#[derive(Debug, Clone, thiserror::Error)]
pub enum SdkError {
    // ---- WS 层 ----
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
    },

    // ---- CLI 层 ----
    #[error("openclaw binary not found: {0}")]
    BinaryNotFound(String),

    #[error("openclaw version {found} < minimum {min}")]
    VersionTooOld { found: String, min: String },

    #[error("command failed (exit {code}): {stderr}")]
    CommandFailed { code: i32, stderr: String },

    #[error("command timed out after {0:?}")]
    CommandTimeout(Duration),

    // ---- 通用 ----
    #[error("json parse error: {0}")]
    Parse(String),

    #[error("io error: {0}")]
    Io(String),
}

// From 实现（thiserror 不支持 #[from] 对 Clone 类型）
impl From<serde_json::Error> for SdkError {
    fn from(e: serde_json::Error) -> Self { Self::Parse(e.to_string()) }
}
impl From<std::io::Error> for SdkError {
    fn from(e: std::io::Error) -> Self { Self::Io(e.to_string()) }
}
```

## 8. Tauri 集成模板（两阶段 + 事件桥接）

```rust
use openclaw_sdk::{DefaultSdk, SdkOptions, ConnectOptions, CliOptions};
use openclaw_sdk::ws::protocol::EventFrame;
use tauri::Manager;

struct AppState {
    sdk: DefaultSdk,
}

#[tauri::command]
async fn gateway_health(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    state.sdk.status().health().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn connect_gateway(state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.sdk.connect_gateway().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn is_connected(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    Ok(state.sdk.is_gateway_connected())
}

#[tauri::command]
async fn run_doctor(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    state.sdk.doctor().run(Default::default()).await.map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // 阶段一：同步创建，立即可用
            let sdk = DefaultSdk::new(SdkOptions {
                gateway: ConnectOptions::default(),
                cli: CliOptions::default(),
            }).expect("failed to init sdk");

            app.manage(AppState { sdk });

            // 阶段二：后台异步连接 Gateway
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = app_handle.state::<AppState>();

                // 尝试连接
                match state.sdk.connect_gateway().await {
                    Ok(()) => {
                        app_handle.emit("gateway-status", "connected").ok();
                    }
                    Err(e) => {
                        tracing::warn!("gateway connect deferred: {e}");
                        app_handle.emit("gateway-status", "disconnected").ok();
                    }
                }

                // 事件桥接：Gateway events → Tauri events
                let mut events = state.sdk.events();
                loop {
                    match events.recv().await {
                        Ok(event) => {
                            let topic = format!("gw:{}", event.event);
                            app_handle.emit(&topic, &event).ok();
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                            tracing::warn!("event bridge lagged, missed {n} events");
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            gateway_health,
            connect_gateway,
            is_connected,
            run_doctor,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run app");
}
```

前端监听：

```typescript
import { listen } from '@tauri-apps/api/event';

// 连接状态
await listen('gateway-status', (e) => console.log('status:', e.payload));
// chat 流式事件
await listen('gw:chat', (e) => console.log('chat:', e.payload));
// 审批请求
await listen('gw:exec.approval.requested', (e) => showApprovalDialog(e.payload));
// 健康变更
await listen('gw:health', (e) => updateHealthIndicator(e.payload));
```

## 9. types/ 设计规范

### 9.1 serde 规范

所有出参类型遵循以下规范：

```rust
/// 非关键字段：Option + default（容忍 schema 漂移）
/// 关键字段：必填（反序列化失败 = 协议不兼容）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewayHealth {
    // 关键字段 — 必填
    pub status: String,

    // 非关键字段 — 容忍缺失
    #[serde(default)]
    pub uptime_seconds: Option<u64>,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub channels: Option<serde_json::Value>,

    // 透传未知字段 — 前向兼容
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}
```

### 9.2 入参规范

```rust
/// 入参使用 builder 风格（Default + skip_serializing_if）
#[derive(Debug, Clone, Serialize, Default)]
pub struct SendParams {
    pub target: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub media: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "replyTo")]
    pub reply_to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "threadId")]
    pub thread_id: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub deliver: bool,
}
```

## 10. 测试策略

### 10.1 单元测试（mock）

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use mockall::mock;

    mock! {
        pub Rpc {}
        #[async_trait]
        impl GatewayRpc for Rpc {
            async fn request_raw(&self, method: &str, params: serde_json::Value)
                -> Result<serde_json::Value, SdkError>;
            async fn notify(&self, method: &str, params: serde_json::Value)
                -> Result<(), SdkError>;
            fn subscribe_events(&self) -> broadcast::Receiver<EventFrame>;
            fn subscribe(&self, event_name: &str)
                -> Pin<Box<dyn Stream<Item = EventFrame> + Send>>;
            fn is_connected(&self) -> bool;
        }
    }

    #[tokio::test]
    async fn test_agent_run() {
        let mut mock = MockRpc::new();
        mock.expect_request_raw()
            .withf(|method, _| method == "agent")
            .returning(|_, _| Ok(serde_json::json!({ "reply": "Hello!" })));

        let methods = AgentMethods { rpc: &mock };
        let result = methods.run(AgentRunParams {
            message: "Hi".into(),
            ..Default::default()
        }).await.unwrap();

        assert_eq!(result.reply, Some("Hello!".into()));
    }
}
```

### 10.2 协议测试

```rust
#[test]
fn test_request_frame_serialization() {
    let frame = RequestFrame {
        frame_type: "req",
        id: "test-1".into(),
        method: "health".into(),
        params: None,
    };
    let json = serde_json::to_string(&frame).unwrap();
    assert!(json.contains(r#""type":"req"#));
    assert!(json.contains(r#""method":"health"#));
    assert!(!json.contains("params")); // skip_serializing_if
}

#[test]
fn test_response_frame_deserialization_tolerant() {
    // 包含未知字段 — 不应 panic
    let json = r#"{"id":"1","ok":true,"payload":{"x":1},"unknownField":42}"#;
    let frame: ResponseFrame = serde_json::from_str(json).unwrap();
    assert!(frame.ok);
}
```

### 10.3 集成测试

```rust
/// 需要真实 Gateway 运行
/// 环境变量：OPENCLAW_TEST_GATEWAY_URL, OPENCLAW_TEST_GATEWAY_TOKEN
/// CI 中通过 #[ignore] 跳过
#[tokio::test]
#[ignore]
async fn integration_health_check() {
    let url = std::env::var("OPENCLAW_TEST_GATEWAY_URL")
        .unwrap_or_else(|_| "ws://127.0.0.1:18789".into());

    let sdk = DefaultSdk::new(SdkOptions {
        gateway: ConnectOptions { url, ..Default::default() },
        cli: CliOptions::default(),
    }).unwrap();

    sdk.connect_gateway().await.unwrap();
    let health = sdk.status().health().await.unwrap();
    assert_eq!(health.status, "ok");
}
```

## 11. 交付里程碑

| 阶段 | 范围 | 交付物 |
|------|------|--------|
| **P0-1** | 基础骨架 | `Cargo.toml`, `error.rs`, `ws/protocol.rs`, `ws/traits.rs`, `cli/traits.rs` |
| **P0-2** | WS 核心 | `ws/actor.rs`, `ws/handshake.rs`, `ws/reconnect.rs`, `ws/auth.rs`, `ws/client.rs`, `ws/events.rs` |
| **P0-3** | CLI 核心 | `cli/executor.rs` |
| **P0-4** | 统一入口 | `sdk.rs`, `lib.rs` |
| **P0-5** | P0 方法 | `methods/status.rs`, `methods/agent.rs`, `methods/message.rs`, `methods/channels.rs`, `methods/config.rs`, `methods/chat.rs` |
| **P0-6** | P0 类型 | `types/gateway.rs`, `types/agent.rs`, `types/message.rs`, `types/channel.rs`, `types/config.rs`, `types/event.rs`, `types/common.rs` |
| **P0-7** | CLI 命令 | `commands/doctor.rs` |
| **P0-8** | 测试 | 单元测试 + 协议测试 |
| **P1** | 管理面板方法 | models/sessions/agents/chat/logs/devices/cron + CLI setup/onboard |
| **P2** | 高级功能方法 | nodes/browser/approvals/skills/usage/secrets + CLI backup/qr |
