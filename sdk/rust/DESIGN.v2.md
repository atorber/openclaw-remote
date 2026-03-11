# OpenClaw Rust SDK 产品设计方案 v2

> v1 → v2 变更：由纯 CLI spawn 方案改为 **WS 直连（主）+ CLI spawn（辅）** 混合架构。v1 见 `DESIGN.v1.md`。

## 1. 定位与目标

**定位**：为 Rust / Tauri 开发者提供类型安全的 OpenClaw Gateway 访问层，作为后续 Tauri 桌面应用的核心后端 SDK。

**目标**：

- 通过 WebSocket 直连 Gateway，提供低延迟的 RPC 调用和实时事件订阅
- 对不经过 Gateway 的本地管理命令，保留 CLI spawn 方式
- 每个操作的入参/出参都有强类型 Rust 结构体
- 为 Tauri 前端提供可直接调用的 `#[tauri::command]` 友好接口

**非目标**：

- 不涉及 MQTT / 加密桥接（那是 `openclaw-mqtt-bridge` 的职责）
- 不重新实现 Gateway 服务端逻辑

## 2. 架构概览

```
┌─────────────────────────────────────────────────────────┐
│                  openclaw-sdk (Rust crate)               │
│                                                         │
│  ┌─────────────────────────┐  ┌──────────────────────┐  │
│  │      ws/ (主通道)        │  │   cli/ (辅助通道)     │  │
│  │                         │  │                      │  │
│  │  持久 WebSocket 连接     │  │  spawn openclaw 子进程│  │
│  │  Gateway RPC 调用       │  │  本地管理命令         │  │
│  │  实时事件订阅            │  │  交互式/离线操作      │  │
│  └───────────┬─────────────┘  └──────────┬───────────┘  │
│              │                           │               │
│  ┌───────────┴───────────────────────────┴───────────┐  │
│  │              types/ (共享类型定义)                   │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
               │                           │
               ▼                           ▼
        ┌─────────────┐           ┌──────────────┐
        │   Gateway    │           │ openclaw CLI  │
        │  (WebSocket) │           │  (本地二进制)   │
        └─────────────┘           └──────────────┘
```

### 通道选择原则

| 走 WS 直连 | 走 CLI spawn |
|------------|-------------|
| 所有 Gateway RPC 方法（约 95+） | 不经过 Gateway 的本地命令 |
| 需要低延迟的高频操作 | 交互式/向导式操作 |
| 需要实时事件推送 | CLI 自身管理（更新/卸载） |

决策矩阵：

| 操作 | 通道 | 原因 |
|------|------|------|
| 消息发送/查询/编辑 | WS `send`, `poll`, `chat.*` | 高频，需要低延迟 |
| Agent turn | WS `agent`, `agent.wait` | 可能长时间等待流式响应 |
| 频道状态/能力 | WS `channels.status` | 查询类，走持久连接快 |
| 频道增删 | CLI `channels add/remove` | 可能触发交互式向导 |
| 配置读写 | WS `config.get/set/apply/patch` | 高频管理操作 |
| 模型列表 | WS `models.list` | 查询类 |
| 模型扫描/认证 | CLI `models scan/auth` | 交互式，涉及外部 OAuth |
| 会话管理 | WS `sessions.*` | 全套 CRUD |
| 定时任务 | WS `cron.*` | 全套 CRUD |
| 节点操作 | WS `node.*` | 需要实时 invoke 结果 |
| 设备配对 | WS `device.pair.*` | 需要实时审批事件 |
| 日志流 | WS `logs.tail` + event 订阅 | 必须流式 |
| 系统事件推送 | WS event 帧 | 必须流式 |
| 浏览器控制 | WS `browser.request` | RPC 调用 |
| 执行审批 | WS `exec.approval.*` | 需要实时请求/决策 |
| Agent/技能管理 | WS `agents.*`, `skills.*` | CRUD |
| 用量统计 | WS `sessions.usage`, `usage.cost` | 查询类 |
| 初始化/设置 | CLI `setup`, `onboard`, `configure` | 纯本地，不依赖 Gateway |
| 健康修复 | CLI `doctor` | 本地检查 + 修复 |
| 更新 CLI | CLI `update` | 自我更新 |
| 备份/重置/卸载 | CLI `backup`, `reset`, `uninstall` | 本地状态操作 |
| Shell 补全 | CLI `completion` | 纯本地 |
| QR 码生成 | CLI `qr` | 本地生成 |

## 3. 目录结构

```
openclaw-remote/sdk/rust/
├── Cargo.toml
├── DESIGN.md
│
├── src/
│   ├── lib.rs                      # 入口，re-export 公共 API
│   ├── error.rs                    # 统一错误类型（WS 层 + CLI 层共用）
│   │
│   ├── ws/                         # ===== WS 直连层 =====
│   │   ├── mod.rs
│   │   ├── client.rs               # GatewayClient — WS 连接管理、握手、重连
│   │   ├── protocol.rs             # 帧编解码：RequestFrame / ResponseFrame / EventFrame
│   │   ├── auth.rs                 # 认证参数构建（token / password）
│   │   ├── events.rs               # 事件流订阅（tokio broadcast → Stream）
│   │   │
│   │   └── methods/                # 类型化 RPC 方法封装（一个文件 = 一个方法组）
│   │       ├── mod.rs
│   │       ├── agent.rs            # agent, agent.wait
│   │       ├── message.rs          # send, poll, chat.send, chat.history, chat.abort
│   │       ├── channels.rs         # channels.status
│   │       ├── config.rs           # config.get, config.set, config.apply, config.patch, config.schema
│   │       ├── models.rs           # models.list
│   │       ├── sessions.rs         # sessions.list, sessions.get, sessions.patch, sessions.delete, sessions.usage
│   │       ├── devices.rs          # device.pair.list, device.pair.approve/reject, device.token.*
│   │       ├── cron.rs             # cron.list, cron.status, cron.add, cron.update, cron.remove, cron.run
│   │       ├── nodes.rs            # node.list, node.describe, node.invoke, node.pair.*
│   │       ├── agents_rpc.rs       # agents.list, agents.create, agents.update, agents.delete, agents.files.*
│   │       ├── skills.rs           # skills.status, skills.install, skills.update
│   │       ├── plugins.rs          # (若 Gateway 暴露 plugin RPC)
│   │       ├── browser.rs          # browser.request
│   │       ├── logs.rs             # logs.tail
│   │       ├── status.rs           # health, status, system-presence, last-heartbeat
│   │       ├── system.rs           # system-event, set-heartbeats
│   │       ├── approvals.rs        # exec.approval.*, exec.approvals.*
│   │       ├── secrets.rs          # secrets.reload, secrets.resolve
│   │       ├── usage.rs            # usage.status, usage.cost, sessions.usage.timeseries
│   │       └── update.rs           # update.run
│   │
│   ├── cli/                        # ===== CLI spawn 层 =====
│   │   ├── mod.rs
│   │   ├── executor.rs             # CliExecutor — spawn 子进程、捕获输出、解析 JSON
│   │   └── commands/               # 本地管理命令
│   │       ├── mod.rs
│   │       ├── setup.rs            # openclaw setup
│   │       ├── onboard.rs          # openclaw onboard
│   │       ├── configure.rs        # openclaw configure
│   │       ├── doctor.rs           # openclaw doctor
│   │       ├── update.rs           # openclaw update (CLI 自身更新)
│   │       ├── backup.rs           # openclaw backup create/verify
│   │       ├── reset.rs            # openclaw reset
│   │       ├── uninstall.rs        # openclaw uninstall
│   │       ├── completion.rs       # openclaw completion
│   │       ├── qr.rs              # openclaw qr
│   │       ├── channels_local.rs   # openclaw channels add/remove/login/logout
│   │       └── models_local.rs     # openclaw models scan/auth
│   │
│   └── types/                      # ===== 共享类型 =====
│       ├── mod.rs
│       ├── channel.rs              # ChannelInfo, ChannelStatus
│       ├── agent.rs                # AgentInfo, AgentTurnResult
│       ├── message.rs              # SendParams, SendResult, PollParams...
│       ├── model.rs                # ModelInfo, ModelStatus
│       ├── gateway.rs              # GatewayHealth, GatewayStatus, HelloPayload
│       ├── session.rs              # SessionInfo, SessionPreview
│       ├── device.rs               # DeviceInfo, PairRequest
│       ├── cron.rs                 # CronJob, CronRun
│       ├── node.rs                 # NodeInfo, InvokeResult
│       ├── config.rs               # ConfigValue, ConfigSchema
│       ├── event.rs                # GatewayEvent 各事件载荷
│       ├── approval.rs             # ApprovalRequest, ApprovalDecision
│       ├── usage.rs                # UsageCost, UsageTimeseries
│       └── common.rs               # 通用字段
│
├── examples/
│   ├── connect_gateway.rs          # WS 连接 + 获取状态
│   ├── send_message.rs             # 发消息
│   ├── agent_turn.rs               # Agent turn
│   ├── event_listener.rs           # 订阅实时事件
│   ├── log_tail.rs                 # 实时日志流
│   └── tauri_integration.rs        # Tauri command 集成示例
│
└── tests/
    ├── protocol_test.rs            # 帧编解码测试
    ├── ws_handshake_test.rs        # 握手流程测试（mock WS server）
    ├── cli_executor_test.rs        # CLI spawn 测试（mock 二进制输出）
    └── integration_test.rs         # 需要真实 Gateway 的集成测试
```

## 4. WS 直连层详细设计

### 4.1 Gateway WS 协议

基于 `openclaw-mqtt-bridge/src/ws-client.ts` 和 Gateway 源码，协议规范如下：

**连接地址**：`ws://127.0.0.1:{port}`（本地）或 `wss://{host}:{port}`（远程）

**帧格式**（JSON 文本帧，三种类型）：

```rust
/// 请求帧（客户端 → 服务端）
#[derive(Debug, Serialize)]
pub struct RequestFrame {
    #[serde(rename = "type")]
    pub frame_type: &'static str,  // 固定 "req"
    pub id: String,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
}

/// 响应帧（服务端 → 客户端）
#[derive(Debug, Deserialize)]
pub struct ResponseFrame {
    pub id: String,
    pub ok: bool,
    #[serde(default)]
    pub payload: Option<serde_json::Value>,
    #[serde(default)]
    pub error: Option<RpcError>,
}

#[derive(Debug, Deserialize)]
pub struct RpcError {
    pub code: String,
    pub message: String,
    #[serde(default)]
    pub details: Option<serde_json::Value>,
}

/// 事件帧（服务端 → 客户端，推送）
#[derive(Debug, Deserialize)]
pub struct EventFrame {
    pub event: String,
    #[serde(default)]
    pub payload: Option<serde_json::Value>,
    #[serde(default)]
    pub seq: Option<u64>,
    #[serde(default, rename = "stateVersion")]
    pub state_version: Option<HashMap<String, u64>>,
}
```

**握手流程**：

```
Client                              Gateway
  │                                    │
  │ ──── WS open ───────────────────→  │
  │                                    │
  │ ←── event: connect.challenge ────  │  { nonce: "..." }
  │                                    │
  │ ──── req: connect ──────────────→  │  { minProtocol: 3, maxProtocol: 3,
  │                                    │    client: { id, version, platform, mode, instanceId },
  │                                    │    role: "operator",
  │                                    │    scopes: ["operator.admin", ...],
  │                                    │    auth: { token? / password? } }
  │                                    │
  │ ←── res: hello-ok ──────────────  │  { server: { version }, snapshot: {...} }
  │                                    │
  │ ════ 连接就绪，可收发 req/event ══  │
```

超时兜底：如果 750ms 内未收到 `connect.challenge`，直接发送 `connect` 请求。

**重连策略**：指数退避 1s → 2s → 4s → ... → 30s 封顶。

**事件类型**（服务端推送）：

| 事件名 | 说明 | 典型场景 |
|--------|------|---------|
| `connect.challenge` | 握手 nonce | 连接初始化 |
| `agent` | Agent 活动流 | 显示 Agent 正在思考/执行 |
| `chat` | 聊天消息流 | 流式回复展示 |
| `presence` | 系统存在状态 | 在线用户/设备列表 |
| `tick` | 心跳保活 | 连接维持 |
| `health` | 健康状态变更 | 状态指示灯 |
| `heartbeat` | 心跳事件 | 定时任务触发 |
| `cron` | 定时任务事件 | 任务运行通知 |
| `node.pair.requested/resolved` | 节点配对 | 审批通知 |
| `device.pair.requested/resolved` | 设备配对 | 审批通知 |
| `exec.approval.requested/resolved` | 执行审批 | 审批通知 |
| `update.available` | 更新可用 | 提示用户更新 |
| `shutdown` | Gateway 关闭 | UI 断连提示 |

### 4.2 GatewayClient 设计

```rust
pub struct GatewayClient {
    url: String,
    auth: AuthConfig,
    /// 活跃的 WS 连接（内部管理重连）
    inner: Arc<Mutex<ClientInner>>,
    /// 事件广播通道
    event_tx: broadcast::Sender<EventFrame>,
    /// pending 请求表
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<ResponseFrame>>>>,
}

pub struct AuthConfig {
    pub token: Option<String>,
    pub password: Option<String>,
}

pub struct ConnectOptions {
    pub url: String,
    pub auth: AuthConfig,
    /// 连接超时
    pub connect_timeout: Duration,   // 默认 10s
    /// 请求超时
    pub request_timeout: Duration,   // 默认 60s
    /// 自动重连
    pub auto_reconnect: bool,        // 默认 true
}

impl GatewayClient {
    /// 连接 Gateway（完成握手后返回）
    pub async fn connect(opts: ConnectOptions) -> Result<Self, SdkError>;

    /// 发送 RPC 请求，等待响应
    pub async fn request<T: DeserializeOwned>(
        &self,
        method: &str,
        params: impl Serialize,
    ) -> Result<T, SdkError>;

    /// 发送 RPC 请求，不等待响应（fire-and-forget）
    pub async fn notify(&self, method: &str, params: impl Serialize) -> Result<(), SdkError>;

    /// 订阅事件流
    pub fn subscribe_events(&self) -> broadcast::Receiver<EventFrame>;

    /// 订阅指定事件名（过滤）
    pub fn subscribe(&self, event_name: &str) -> impl Stream<Item = EventFrame>;

    /// 连接状态
    pub fn is_connected(&self) -> bool;

    /// hello-ok 中的 server info
    pub fn server_info(&self) -> Option<&ServerInfo>;

    /// 主动断开
    pub async fn disconnect(&self);
}
```

### 4.3 类型化 RPC 方法封装

```rust
// ---- ws/methods/agent.rs ----

pub struct AgentMethods<'a> {
    client: &'a GatewayClient,
}

#[derive(Debug, Serialize, Default)]
pub struct AgentRunParams {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "sessionId")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<ThinkingLevel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deliver: Option<bool>,
}

impl<'a> AgentMethods<'a> {
    pub async fn run(&self, params: AgentRunParams) -> Result<AgentTurnResult, SdkError> {
        self.client.request("agent", &params).await
    }

    pub async fn wait(&self, params: AgentWaitParams) -> Result<AgentTurnResult, SdkError> {
        self.client.request("agent.wait", &params).await
    }
}

// ---- ws/methods/message.rs ----

pub struct MessageMethods<'a> {
    client: &'a GatewayClient,
}

impl<'a> MessageMethods<'a> {
    pub async fn send(&self, params: SendParams) -> Result<SendResult, SdkError> {
        self.client.request("send", &params).await
    }

    pub async fn poll(&self, params: PollParams) -> Result<PollResult, SdkError> {
        self.client.request("poll", &params).await
    }
}

// ---- ws/methods/chat.rs ----

pub struct ChatMethods<'a> {
    client: &'a GatewayClient,
}

impl<'a> ChatMethods<'a> {
    pub async fn send(&self, params: ChatSendParams) -> Result<serde_json::Value, SdkError> {
        self.client.request("chat.send", &params).await
    }

    pub async fn history(&self, params: ChatHistoryParams) -> Result<Vec<ChatMessage>, SdkError> {
        self.client.request("chat.history", &params).await
    }

    pub async fn abort(&self) -> Result<(), SdkError> {
        self.client.request::<serde_json::Value>("chat.abort", &()).await?;
        Ok(())
    }

    /// 订阅 chat 流式事件
    pub fn stream(&self) -> impl Stream<Item = EventFrame> {
        self.client.subscribe("chat")
    }
}

// ---- ws/methods/status.rs ----

pub struct StatusMethods<'a> {
    client: &'a GatewayClient,
}

impl<'a> StatusMethods<'a> {
    pub async fn health(&self) -> Result<GatewayHealth, SdkError> {
        self.client.request("health", &()).await
    }

    pub async fn status(&self) -> Result<GatewayStatus, SdkError> {
        self.client.request("status", &()).await
    }

    pub async fn presence(&self) -> Result<Vec<PresenceEntry>, SdkError> {
        self.client.request("system-presence", &()).await
    }
}
```

### 4.4 统一入口 — OpenClawSdk

```rust
/// SDK 统一入口，聚合 WS 和 CLI 两个通道
pub struct OpenClawSdk {
    /// WS 直连（需要 Gateway 运行）
    gateway: GatewayClient,
    /// CLI spawn（本地命令）
    cli: CliExecutor,
}

impl OpenClawSdk {
    pub async fn connect(opts: SdkOptions) -> Result<Self, SdkError> {
        let gateway = GatewayClient::connect(opts.gateway).await?;
        let cli = CliExecutor::new(opts.cli)?;
        Ok(Self { gateway, cli })
    }

    // ---- WS 方法组 ----
    pub fn agent(&self) -> AgentMethods<'_>     { AgentMethods { client: &self.gateway } }
    pub fn message(&self) -> MessageMethods<'_> { MessageMethods { client: &self.gateway } }
    pub fn chat(&self) -> ChatMethods<'_>       { ChatMethods { client: &self.gateway } }
    pub fn channels(&self) -> ChannelMethods<'_>{ ChannelMethods { client: &self.gateway } }
    pub fn config(&self) -> ConfigMethods<'_>   { ConfigMethods { client: &self.gateway } }
    pub fn models(&self) -> ModelMethods<'_>    { ModelMethods { client: &self.gateway } }
    pub fn sessions(&self) -> SessionMethods<'_>{ SessionMethods { client: &self.gateway } }
    pub fn cron(&self) -> CronMethods<'_>       { CronMethods { client: &self.gateway } }
    pub fn nodes(&self) -> NodeMethods<'_>      { NodeMethods { client: &self.gateway } }
    pub fn devices(&self) -> DeviceMethods<'_>  { DeviceMethods { client: &self.gateway } }
    pub fn browser(&self) -> BrowserMethods<'_> { BrowserMethods { client: &self.gateway } }
    pub fn logs(&self) -> LogMethods<'_>        { LogMethods { client: &self.gateway } }
    pub fn status(&self) -> StatusMethods<'_>   { StatusMethods { client: &self.gateway } }
    pub fn approvals(&self) -> ApprovalMethods<'_> { ApprovalMethods { client: &self.gateway } }
    pub fn agents_rpc(&self) -> AgentsRpcMethods<'_> { AgentsRpcMethods { client: &self.gateway } }
    pub fn skills(&self) -> SkillMethods<'_>    { SkillMethods { client: &self.gateway } }
    pub fn usage(&self) -> UsageMethods<'_>     { UsageMethods { client: &self.gateway } }
    pub fn system(&self) -> SystemMethods<'_>   { SystemMethods { client: &self.gateway } }
    pub fn secrets(&self) -> SecretMethods<'_>  { SecretMethods { client: &self.gateway } }

    // ---- CLI 方法组 ----
    pub fn setup(&self) -> SetupCmd<'_>         { SetupCmd { cli: &self.cli } }
    pub fn doctor(&self) -> DoctorCmd<'_>       { DoctorCmd { cli: &self.cli } }
    pub fn update(&self) -> UpdateCmd<'_>       { UpdateCmd { cli: &self.cli } }
    pub fn backup(&self) -> BackupCmd<'_>       { BackupCmd { cli: &self.cli } }
    pub fn reset(&self) -> ResetCmd<'_>         { ResetCmd { cli: &self.cli } }
    pub fn qr(&self) -> QrCmd<'_>              { QrCmd { cli: &self.cli } }

    // ---- 事件订阅 ----
    pub fn events(&self) -> broadcast::Receiver<EventFrame> {
        self.gateway.subscribe_events()
    }

    // ---- 连接状态 ----
    pub fn is_connected(&self) -> bool { self.gateway.is_connected() }
    pub fn server_info(&self) -> Option<&ServerInfo> { self.gateway.server_info() }
    pub async fn disconnect(&self) { self.gateway.disconnect().await }
}
```

### 4.5 Tauri 集成示例

```rust
use openclaw_sdk::{OpenClawSdk, SdkOptions};
use tauri::Manager;

// Tauri State 单例
struct AppState {
    sdk: OpenClawSdk,
}

#[tauri::command]
async fn gateway_health(state: tauri::State<'_, AppState>) -> Result<GatewayHealth, String> {
    state.sdk.status().health().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn send_message(
    state: tauri::State<'_, AppState>,
    target: String,
    message: String,
) -> Result<SendResult, String> {
    state.sdk.message().send(SendParams {
        target,
        message: Some(message),
        ..Default::default()
    }).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn agent_run(
    state: tauri::State<'_, AppState>,
    message: String,
    thinking: Option<String>,
) -> Result<AgentTurnResult, String> {
    state.sdk.agent().run(AgentRunParams {
        message,
        thinking: thinking.map(|t| t.parse().unwrap_or(ThinkingLevel::Low)),
        ..Default::default()
    }).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_channels(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    state.sdk.channels().status().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn run_doctor(state: tauri::State<'_, AppState>) -> Result<String, String> {
    // 走 CLI spawn（本地命令，不依赖 Gateway）
    state.sdk.doctor().run(DoctorParams { deep: true, repair: false })
        .await.map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let rt = tokio::runtime::Runtime::new().unwrap();
            let sdk = rt.block_on(async {
                OpenClawSdk::connect(SdkOptions {
                    gateway: ConnectOptions {
                        url: "ws://127.0.0.1:18789".into(),
                        auth: AuthConfig::from_env_or_config(),
                        ..Default::default()
                    },
                    cli: CliOptions::default(),
                }).await
            }).expect("failed to connect");
            app.manage(AppState { sdk });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            gateway_health,
            send_message,
            agent_run,
            list_channels,
            run_doctor,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run app");
}
```

## 5. CLI spawn 层详细设计

保留用于不经过 Gateway 的本地命令，设计同 v1，但范围缩小：

```rust
pub struct CliExecutor {
    bin_path: PathBuf,
    global_flags: GlobalFlags,
    timeout: Duration,
    /// 环境变量白名单
    env_allowlist: HashMap<String, String>,
}

impl CliExecutor {
    pub fn new(opts: CliOptions) -> Result<Self, SdkError>;

    /// 执行命令，返回 JSON 输出
    pub async fn exec_json(&self, args: &[&str]) -> Result<serde_json::Value, SdkError>;

    /// 执行命令，返回原始文本
    pub async fn exec_raw(&self, args: &[&str]) -> Result<CommandOutput, SdkError>;

    /// 获取 CLI 版本
    pub async fn version(&self) -> Result<String, SdkError>;
}

pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}
```

## 6. 错误类型

```rust
#[derive(Debug, thiserror::Error)]
pub enum SdkError {
    // ---- WS 层 ----
    /// WebSocket 连接失败
    #[error("ws connect failed: {0}")]
    WsConnect(String),

    /// 握手失败（认证错误等）
    #[error("handshake failed: {0}")]
    HandshakeFailed(String),

    /// WS 连接断开
    #[error("ws disconnected: {reason}")]
    Disconnected { reason: String },

    /// RPC 请求超时
    #[error("request timed out after {0:?}")]
    RequestTimeout(Duration),

    /// Gateway 返回的 RPC 错误
    #[error("rpc error [{code}]: {message}")]
    RpcError { code: String, message: String, details: Option<serde_json::Value> },

    // ---- CLI 层 ----
    /// openclaw 二进制未找到
    #[error("openclaw binary not found: {0}")]
    BinaryNotFound(String),

    /// CLI 版本过低
    #[error("openclaw version {found} < minimum {min}")]
    VersionTooOld { found: String, min: String },

    /// CLI 命令执行失败
    #[error("command failed (exit {code}): {stderr}")]
    CommandFailed { code: i32, stderr: String },

    /// CLI 命令超时
    #[error("command timed out after {0:?}")]
    CommandTimeout(Duration),

    // ---- 通用 ----
    /// JSON 解析错误
    #[error("parse error: {0}")]
    Parse(#[from] serde_json::Error),

    /// IO 错误
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}
```

## 7. 关键依赖

```toml
[package]
name = "openclaw-sdk"
version = "0.1.0"
edition = "2021"

[dependencies]
# WS 层
tokio-tungstenite = "0.24"                        # async WebSocket
futures-util = "0.3"                               # Stream/Sink 工具
tokio = { version = "1", features = ["process", "time", "sync", "macros", "rt-multi-thread"] }

# 序列化
serde = { version = "1", features = ["derive"] }
serde_json = "1"

# 错误处理 + 日志
thiserror = "2"
tracing = "0.1"

# CLI 层
which = "7"                                        # 查找 openclaw 二进制

# 工具
uuid = { version = "1", features = ["v4"] }        # 请求 ID 生成

[dev-dependencies]
tokio = { version = "1", features = ["full"] }
tokio-test = "0.4"
```

## 8. 命令覆盖范围（分期）

### P0 — 核心（桌面应用最小可用）

| 通道 | 命令组 | 方法 |
|------|--------|------|
| WS | status | `health`, `status` |
| WS | channels | `channels.status` |
| WS | message | `send` |
| WS | agent | `agent` |
| WS | config | `config.get`, `config.set` |
| WS | events | `chat`, `health`, `presence` 事件订阅 |
| CLI | doctor | `doctor` |

### P1 — 管理面板

| 通道 | 命令组 | 方法 |
|------|--------|------|
| WS | models | `models.list` |
| WS | sessions | `sessions.list`, `sessions.patch`, `sessions.delete` |
| WS | agents | `agents.list`, `agents.create`, `agents.update`, `agents.delete` |
| WS | chat | `chat.send`, `chat.history`, `chat.abort` + `chat` event stream |
| WS | logs | `logs.tail` + event stream |
| WS | devices | `device.pair.*` |
| WS | cron | `cron.*` |
| CLI | setup | `setup`, `onboard` |

### P2 — 高级功能

| 通道 | 命令组 | 方法 |
|------|--------|------|
| WS | nodes | `node.list`, `node.invoke`, `node.pair.*` |
| WS | browser | `browser.request` |
| WS | approvals | `exec.approval.*`, `exec.approvals.*` |
| WS | skills | `skills.status`, `skills.install` |
| WS | usage | `usage.cost`, `sessions.usage.*` |
| WS | secrets | `secrets.reload` |
| CLI | backup | `backup create/verify` |
| CLI | qr | `qr --json` |

## 9. 设计原则

1. **WS 优先**：所有 Gateway RPC 操作走 WS 持久连接，毫秒级延迟，支持事件推送
2. **CLI 兜底**：不经过 Gateway 的本地管理命令走 CLI spawn，职责明确
3. **强类型**：入参 `Serialize`、出参 `DeserializeOwned`，编译时检查
4. **Tauri State 单例**：`OpenClawSdk` 作为 Tauri managed state，全生命周期复用连接
5. **容错解析**：`types/` 字段使用 `#[serde(default)]` 防御 schema 漂移
6. **事件驱动**：桌面 UI 通过 `subscribe("chat")` 等获取实时推送，不轮询
