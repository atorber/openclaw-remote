# OpenClaw Rust SDK v2 设计方案 — 架构评审

评审日期：2026-03-11

> 基于 `DESIGN.v2.md`（WS 直连 + CLI spawn 混合架构）。v1 评审见 `REVIEW.v1.md`。

## 一、v1 → v2 关键改进回顾

| 维度 | v1（纯 CLI spawn） | v2（WS + CLI 混合） | 评价 |
|------|-------------------|-------------------|------|
| 延迟 | 每次 200-500ms+（Node.js 冷启动） | WS 持久连接，毫秒级 | 核心瓶颈解决 |
| 实时能力 | 无 | 事件订阅（chat/log/health/approval） | 桌面应用必备 |
| 连接复用 | 无 | 单 WS 持久连接 | 资源效率大幅提升 |
| 覆盖面 | 48 CLI 命令全封装 | WS ~95 RPC + CLI ~12 本地命令 | 覆盖更全且分工合理 |

## 二、整体评价

方案架构方向正确，WS/CLI 分工清晰。以下从六个维度逐一审查。

## 三、可靠性

### 3.1 【高风险】Gateway 未启动时 SDK 不可用

`OpenClawSdk::connect()` 要求 Gateway 已在运行，WS 握手成功后才返回。但 Tauri 应用启动时 Gateway 可能还没起来（用户刚开机、Gateway 崩溃待修复、首次安装尚未 setup）。

当前设计下，如果 Gateway 不可达，`connect()` 直接返回 `Err`，整个 SDK 创建失败——CLI 层也无法使用，而 CLI 层恰恰是不依赖 Gateway 的。

**建议**：将 `OpenClawSdk` 改为两阶段初始化：

```rust
impl OpenClawSdk {
    /// 阶段一：立即可用（仅 CLI 层就绪）
    pub fn new(opts: SdkOptions) -> Result<Self, SdkError>;

    /// 阶段二：连接 Gateway（可多次调用，幂等）
    pub async fn connect_gateway(&self) -> Result<(), SdkError>;

    /// Gateway 是否已连接
    pub fn is_gateway_connected(&self) -> bool;
}
```

WS 方法在未连接时返回 `SdkError::GatewayNotConnected`，而非 panic。这样 Tauri 应用可以先渲染 UI、跑 `doctor`，后台自动尝试连接 Gateway。

### 3.2 【高风险】WS 断连期间的请求行为未定义

设计中 `GatewayClient` 有自动重连，但未说明重连期间调用 `request()` 会怎样：
- 立即返回错误？
- 排队等重连成功？
- 超时后失败？

不同场景需要不同策略（UI 刷新操作应快速失败，agent turn 可以等一下）。

**建议**：增加 `DisconnectPolicy` 并允许 per-request 覆盖：

```rust
pub struct ConnectOptions {
    // ...
    pub disconnect_policy: DisconnectPolicy,
}

pub enum DisconnectPolicy {
    /// 立即返回 Disconnected 错误
    FailFast,
    /// 排队等待重连，超过 duration 后失败
    WaitReconnect(Duration),
}

impl GatewayClient {
    /// 带覆盖策略的请求
    pub async fn request_with_policy<T: DeserializeOwned>(
        &self,
        method: &str,
        params: impl Serialize,
        policy: DisconnectPolicy,
    ) -> Result<T, SdkError>;
}
```

### 3.3 【中风险】broadcast channel 容量与背压

`broadcast::Sender<EventFrame>` 是有界的。如果某个 `Receiver` 消费慢（如 Tauri 前端卡顿），会发生 `RecvError::Lagged(n)` 丢消息。

对于 `chat` 流式事件，丢消息意味着 UI 上回复内容不完整；对于 `exec.approval.requested`，丢消息意味着审批弹窗不弹出。

**建议**：
- 给 broadcast channel 设一个合理的容量（如 256）
- 在 `subscribe()` 返回的 Stream 中处理 `Lagged`：对关键事件（approval/device.pair）做补偿查询
- 文档中明确：事件是 best-effort 推送，关键状态应通过 RPC 轮询确认

## 四、并发安全

### 4.1 【中风险】`Arc<Mutex<HashMap<String, oneshot::Sender>>>` 的锁竞争

`pending` 表用 `Mutex` 保护。每次发请求要锁一次（插入），每次收响应要锁一次（移除）。在高并发场景（如批量发消息 + 密集事件流同时处理）下，锁竞争可能成为瓶颈。

**建议**：改用无锁并发 map：

```rust
use dashmap::DashMap;

pending: Arc<DashMap<String, oneshot::Sender<ResponseFrame>>>,
```

或使用 `tokio::sync::Mutex`（async-aware，不会阻塞 executor）替代 `std::sync::Mutex`。设计文档应明确使用哪种 `Mutex`。

### 4.2 【低风险】`inner: Arc<Mutex<ClientInner>>` 定义不明

`ClientInner` 没有展开定义。这是 WS 连接管理的核心，需要明确：
- 它持有什么（WS sink/stream split? 连接状态机?）
- 哪些操作需要锁（发送帧? 状态切换?）
- 重连时是否需要排他锁

**建议**：展开 `ClientInner` 的结构设计，或改为 actor 模型（一个 tokio task 独占 WS 读写，通过 channel 与外部通信），避免直接暴露锁。

## 五、API 设计

### 5.1 【中风险】`request<T>` 的泛型人体工程学

```rust
pub async fn request<T: DeserializeOwned>(
    &self,
    method: &str,
    params: impl Serialize,
) -> Result<T, SdkError>;
```

调用 `request::<serde_json::Value>("method", &())` 时需要显式指定 turbofish 泛型。这对 methods 层封装没问题（内部指定了类型），但如果用户想直接调底层 `client.request()`，人体工程学较差。

**建议**：增加一个不带泛型的 `request_raw` 作为逃生舱口：

```rust
/// 返回原始 JSON payload
pub async fn request_raw(
    &self,
    method: &str,
    params: impl Serialize,
) -> Result<serde_json::Value, SdkError>;
```

### 5.2 【低风险】`subscribe()` 的过滤发生在消费端

```rust
pub fn subscribe(&self, event_name: &str) -> impl Stream<Item = EventFrame>
```

当前设计是所有事件广播到所有 subscriber，然后在 `subscribe("chat")` 返回的 Stream 里做 `filter`。如果事件量大（高频 `tick` + `presence` + `chat`），每个 subscriber 都要遍历全部事件。

对当前规模（桌面应用，事件量有限）这不是问题，但值得注明：这是客户端过滤，不是服务端过滤。

### 5.3 【建议】methods 层的命名歧义

- `sdk.agents_rpc()` — 为什么后缀 `_rpc`？因为和 CLI 层的 `agents` 命令重名？
- `sdk.message()` 封装的是 `send`/`poll`（Gateway RPC 方法名），而 `sdk.chat()` 封装的是 `chat.send`/`chat.history`——两者都涉及"消息"，但语义不同

**建议**：统一命名约定并在文档中说明：
- `message()` = 跨频道的出站消息操作（面向外部联系人）
- `chat()` = webchat 会话操作（面向 UI 操作者自己的对话）
- `agents_rpc()` → 直接命名为 `agents()`，CLI 层对应的叫 `agents_local()`（或去掉，因为 CLI 层没有 agents 命令）

## 六、可测试性

### 6.1 【中风险】缺少 trait 抽象，难以 mock

`GatewayClient` 是具体结构体，methods 层直接持有 `&GatewayClient`。单元测试时无法注入 mock。

**建议**：抽取 trait：

```rust
#[async_trait]
pub trait GatewayRpc: Send + Sync {
    async fn request_raw(&self, method: &str, params: serde_json::Value)
        -> Result<serde_json::Value, SdkError>;
    fn subscribe_events(&self) -> broadcast::Receiver<EventFrame>;
}

impl GatewayRpc for GatewayClient { ... }

pub struct AgentMethods<'a, C: GatewayRpc> {
    client: &'a C,
}
```

同理，`CliExecutor` 也可以抽取 trait：

```rust
#[async_trait]
pub trait CliExec: Send + Sync {
    async fn exec_json(&self, args: &[&str]) -> Result<serde_json::Value, SdkError>;
    async fn exec_raw(&self, args: &[&str]) -> Result<CommandOutput, SdkError>;
}
```

这样测试时可以用 `MockGatewayRpc` / `MockCliExec` 替代真实连接。

### 6.2 【低风险】集成测试依赖真实 Gateway

`tests/integration_test.rs` 需要真实 Gateway。应补充说明如何运行：
- 环境变量（`OPENCLAW_TEST_GATEWAY_URL`, `OPENCLAW_TEST_GATEWAY_TOKEN`）
- CI 中是否跳过
- 是否提供 mock Gateway server 的 test fixture

## 七、Tauri 集成

### 7.1 【中风险】`setup` 中的 `block_on` 阻塞主线程

```rust
.setup(|app| {
    let rt = tokio::runtime::Runtime::new().unwrap();
    let sdk = rt.block_on(async { ... }).expect("failed to connect");
```

Tauri 的 `setup` 回调运行在主线程。`block_on` 在 WS 连接失败时会阻塞（等待 `connect_timeout` 到期），导致应用窗口长时间无响应。

**建议**：结合 3.1 的两阶段初始化：

```rust
.setup(|app| {
    let sdk = OpenClawSdk::new(opts)?;  // 仅初始化 CLI 层，同步，立即返回
    app.manage(AppState { sdk });

    // 后台连接 Gateway
    let sdk_ref = app.state::<AppState>();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = sdk_ref.sdk.connect_gateway().await {
            tracing::warn!("gateway connect deferred: {e}");
        }
    });

    Ok(())
})
```

### 7.2 【建议】事件桥接到 Tauri event system

桌面应用前端需要接收 Gateway 事件。当前设计只到 Rust 侧的 `broadcast::Receiver`，没有说明如何桥接到 Tauri 的 `app.emit()` / `window.emit()`。

**建议**：在文档中补充桥接模式：

```rust
// 在 setup 中启动事件转发 task
tauri::async_runtime::spawn(async move {
    let mut events = sdk.events();
    while let Ok(event) = events.recv().await {
        app_handle.emit("openclaw-event", &event).ok();
    }
});
```

前端监听：

```typescript
import { listen } from '@tauri-apps/api/event';
await listen<EventFrame>('openclaw-event', (e) => { ... });
```

## 八、遗漏项

### 8.1 Gateway 认证凭据来源

`AuthConfig::from_env_or_config()` 出现在示例中但未定义。SDK 需要明确凭据解析链：

1. 显式传入（`ConnectOptions.auth`）
2. 环境变量（`OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD`）
3. 配置文件（`~/.openclaw/openclaw.json` → `gateway.auth.*`）

**建议**：在 `ws/auth.rs` 中实现完整解析链，并在设计文档 4.2 节补充。

### 8.2 TLS / wss 支持

文档 4.1 提到了 `wss://{host}:{port}`（远程），但依赖和设计中未提及 TLS 支持。`tokio-tungstenite` 需要启用 `native-tls` 或 `rustls-tls-webpki-roots` feature 才能支持 wss。

**建议**：在 `Cargo.toml` 中明确：

```toml
tokio-tungstenite = { version = "0.24", features = ["rustls-tls-webpki-roots"] }
```

### 8.3 `logs.tail` 的流式语义

`logs.tail` 是一次性 RPC 调用返回最近 N 行，还是持久订阅？文档决策矩阵写的是「WS `logs.tail` + event 订阅」，但 methods 层 `logs.rs` 只列了 `logs.tail`。

从 Gateway 源码看，`logs.tail` 返回一批日志行（一次性），实时日志则通过某种事件推送。需要在设计中明确两者的 SDK API 区别。

### 8.4 Cargo features 拆分

如果消费者只需要 WS 层（嵌入式 Rust 服务端）或只需要 CLI 层（CI 脚本），可按需编译：

```toml
[features]
default = ["ws", "cli"]
ws = ["tokio-tungstenite", "futures-util"]
cli = ["which"]
```

这不影响 P0 交付，但建议从代码结构上保留可拆分性（`ws/` 和 `cli/` 不交叉依赖）。

## 九、总结

| 优先级 | 改进项 | 章节 | 工作量 |
|--------|--------|------|--------|
| **必须** | 两阶段初始化（Gateway 可延迟连接） | 3.1, 7.1 | 小 |
| **必须** | 断连期间请求行为定义 + DisconnectPolicy | 3.2 | 小 |
| **必须** | TLS/wss 依赖声明 | 8.2 | 极小 |
| **建议** | broadcast 容量与 Lagged 处理策略 | 3.3 | 小 |
| **建议** | pending map 改用 DashMap 或 tokio::sync::Mutex | 4.1 | 小 |
| **建议** | trait 抽象（GatewayRpc / CliExec）便于 mock | 6.1 | 中 |
| **建议** | 增加 `request_raw` 逃生舱口 | 5.1 | 极小 |
| **建议** | 认证凭据解析链明确 | 8.1 | 小 |
| **建议** | Tauri 事件桥接模式写入文档 | 7.2 | 极小 |
| **建议** | methods 命名统一（agents_rpc → agents） | 5.3 | 极小 |
| **远期** | Cargo features 拆分 ws/cli | 8.4 | 小 |
| **远期** | actor 模型替代 ClientInner Mutex | 4.2 | 中 |

**结论：方案整体可行，3 个"必须"项属于工程细节补全，不影响架构方向。建议合并必须项后即可启动 P0 编码。**
