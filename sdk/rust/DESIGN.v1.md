# OpenClaw Rust SDK 产品设计方案

## 1. 定位与目标

**定位**：为 Rust / Tauri 开发者提供类型安全的 OpenClaw CLI 封装层，通过调用本地 `openclaw` 二进制（子进程 + `--json` 输出）实现对全部 CLI 能力的程序化访问。后续基于此 SDK 构建 Tauri 桌面应用。

**目标**：

- 封装 `openclaw` CLI 全部命令为类型化 Rust API（spawn 子进程，解析 `--json` 输出）
- 每个命令的入参/出参都有强类型 Rust 结构体，编译时检查
- 为 Tauri 前端提供可直接调用的 `#[tauri::command]` 友好接口

**非目标**：

- 不涉及 MQTT / WebSocket / 加密等网络协议
- 不直接与 Gateway 通信，仅通过 CLI 二进制间接操作

## 2. 目录结构

```
openclaw-remote/sdk/rust/
├── Cargo.toml
├── DESIGN.md                   # 本文件
├── src/
│   ├── lib.rs                  # 入口，re-export 所有公共模块
│   ├── client.rs               # OpenClawCli — 核心执行器（spawn openclaw + 参数拼装 + JSON 解析）
│   ├── error.rs                # 统一错误类型（CliError：进程失败 / JSON 解析失败 / 命令错误）
│   ├── config.rs               # SDK 配置（openclaw 二进制路径、全局 flags、超时等）
│   ├── output.rs               # 通用 CLI 输出解析（JSON stdout、stderr 处理）
│   │
│   ├── commands/               # 按 CLI 命令分组的高层 API（一个文件 = 一个命令组）
│   │   ├── mod.rs
│   │   ├── agent.rs            # openclaw agent
│   │   ├── agents.rs           # openclaw agents list/add/delete/bind/unbind
│   │   ├── message.rs          # openclaw message send/poll/react/edit/delete/search/broadcast...
│   │   ├── channels.rs         # openclaw channels list/status/add/remove/login/logout/capabilities
│   │   ├── config_cmd.rs       # openclaw config get/set/unset/validate
│   │   ├── models.rs           # openclaw models status/list/set/scan/auth
│   │   ├── gateway.rs          # openclaw gateway run/health/status/probe/install/start/stop
│   │   ├── status.rs           # openclaw status
│   │   ├── health.rs           # openclaw health
│   │   ├── sessions.rs         # openclaw sessions list/cleanup
│   │   ├── devices.rs          # openclaw devices list/approve/reject/remove
│   │   ├── plugins.rs          # openclaw plugins list/install/enable/disable/doctor
│   │   ├── cron.rs             # openclaw cron list/add/edit/rm/enable/disable/run
│   │   ├── hooks.rs            # openclaw hooks list/info/enable/disable/install
│   │   ├── nodes.rs            # openclaw nodes list/status/invoke/camera/canvas/screen
│   │   ├── node.rs             # openclaw node run/status/install/stop
│   │   ├── browser.rs          # openclaw browser navigate/screenshot/click/type...
│   │   ├── directory.rs        # openclaw directory self/peers/groups
│   │   ├── memory.rs           # openclaw memory status/index/search
│   │   ├── pairing.rs          # openclaw pairing list/approve
│   │   ├── approvals.rs        # openclaw approvals get/set/allowlist
│   │   ├── logs.rs             # openclaw logs
│   │   ├── system.rs           # openclaw system event/heartbeat/presence
│   │   ├── secrets.rs          # openclaw secrets reload/audit/configure
│   │   ├── security.rs         # openclaw security audit
│   │   ├── skills.rs           # openclaw skills list/info/check
│   │   ├── sandbox.rs          # openclaw sandbox list/recreate
│   │   ├── backup.rs           # openclaw backup create/verify
│   │   ├── doctor.rs           # openclaw doctor
│   │   ├── update.rs           # openclaw update
│   │   └── qr.rs               # openclaw qr
│   │
│   └── types/                  # 共享类型定义（CLI --json 输出结构）
│       ├── mod.rs
│       ├── channel.rs          # ChannelInfo, ChannelStatus, ChannelCapability
│       ├── agent.rs            # AgentInfo, AgentTurnResult
│       ├── message.rs          # SendResult, PollResult, Reaction...
│       ├── model.rs            # ModelInfo, ModelStatus, AuthProfile
│       ├── gateway.rs          # GatewayHealth, GatewayStatus
│       ├── session.rs          # SessionInfo
│       ├── device.rs           # DeviceInfo
│       ├── plugin.rs           # PluginInfo
│       ├── cron.rs             # CronJob, CronRun
│       ├── node.rs             # NodeInfo, NodeStatus
│       ├── common.rs           # 通用字段（分页、时间戳等）
│       └── config.rs           # ConfigValue, ValidationResult
│
├── examples/
│   ├── send_message.rs         # 发消息示例
│   ├── agent_turn.rs           # agent turn 示例
│   ├── list_channels.rs        # 查看频道示例
│   └── tauri_integration.rs    # Tauri command 集成示例
│
└── tests/
    ├── cli_mock_test.rs        # mock 子进程输出的单元测试
    └── integration_test.rs     # 需要真实 openclaw 二进制的集成测试
```

## 3. 核心架构

### 3.1 执行层 (`client.rs`)

```
┌────────────────┐    spawn + args     ┌───────────────┐
│  Rust SDK      │ ──────────────────→ │ openclaw CLI  │
│ (OpenClawCli)  │ ←── stdout (JSON) ─ │ (子进程)       │
│                │ ←── stderr ──────── │               │
│                │ ←── exit code ───── │               │
└────────────────┘                     └───────────────┘
```

核心原理：

1. 所有 CLI 命令都支持 `--json` 标志，输出结构化 JSON 到 stdout
2. SDK 通过 `tokio::process::Command` spawn `openclaw` 子进程
3. 拼装命令行参数，附加 `--json --no-color`
4. 捕获 stdout 解析为强类型结构体，捕获 stderr 作为错误信息
5. 根据 exit code 判断成功/失败

### 3.2 核心执行器

```rust
/// SDK 入口 — 封装 openclaw CLI 调用
pub struct OpenClawCli {
    /// openclaw 二进制路径（默认从 PATH 查找）
    bin_path: PathBuf,
    /// 全局 flags（--dev, --profile, --no-color 等）
    global_flags: GlobalFlags,
    /// 命令执行超时
    timeout: Duration,
}

pub struct GlobalFlags {
    pub dev: bool,
    pub profile: Option<String>,
    pub no_color: bool,  // 默认 true
}

impl OpenClawCli {
    /// 从 PATH 查找 openclaw 二进制
    pub fn new() -> Result<Self, CliError>;

    /// 指定二进制路径
    pub fn with_bin(bin_path: impl Into<PathBuf>) -> Self;

    /// 底层：执行任意命令，返回原始 JSON
    pub async fn exec(&self, args: &[&str]) -> Result<serde_json::Value, CliError>;

    /// 底层：执行命令，返回原始字符串输出（用于非 JSON 命令）
    pub async fn exec_raw(&self, args: &[&str]) -> Result<String, CliError>;

    /// 获取命令组 API
    pub fn agent(&self) -> AgentCmd<'_>;
    pub fn agents(&self) -> AgentsCmd<'_>;
    pub fn message(&self) -> MessageCmd<'_>;
    pub fn channels(&self) -> ChannelsCmd<'_>;
    pub fn config(&self) -> ConfigCmd<'_>;
    pub fn models(&self) -> ModelsCmd<'_>;
    pub fn gateway(&self) -> GatewayCmd<'_>;
    pub fn status(&self) -> StatusCmd<'_>;
    pub fn health(&self) -> HealthCmd<'_>;
    // ... 其他命令组
}
```

### 3.3 命令组 API 示例

```rust
// ---- commands/agent.rs ----

pub struct AgentCmd<'a> {
    cli: &'a OpenClawCli,
}

#[derive(Default)]
pub struct AgentRunParams {
    pub message: String,
    pub to: Option<String>,
    pub session_id: Option<String>,
    pub thinking: Option<ThinkingLevel>,
    pub agent: Option<String>,
    pub channel: Option<String>,
    pub local: bool,
    pub deliver: bool,
    pub timeout: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct AgentTurnResult {
    pub reply: Option<String>,
    pub session_id: Option<String>,
    pub agent_id: Option<String>,
    // ...
}

impl<'a> AgentCmd<'a> {
    pub async fn run(&self, params: AgentRunParams) -> Result<AgentTurnResult, CliError> {
        let mut args = vec!["agent", "--json"];
        args.extend(["--message", &params.message]);
        if let Some(ref to) = params.to {
            args.extend(["--to", to]);
        }
        if let Some(ref thinking) = params.thinking {
            args.extend(["--thinking", thinking.as_str()]);
        }
        if params.deliver {
            args.push("--deliver");
        }
        // ... 其他参数
        let value = self.cli.exec(&args).await?;
        Ok(serde_json::from_value(value)?)
    }
}

// ---- commands/message.rs ----

pub struct MessageCmd<'a> {
    cli: &'a OpenClawCli,
}

#[derive(Default)]
pub struct SendMessageParams {
    pub channel: Option<String>,
    pub account: Option<String>,
    pub target: String,
    pub message: Option<String>,
    pub media: Vec<String>,
    pub reply_to: Option<String>,
    pub thread_id: Option<String>,
    pub dry_run: bool,
}

impl<'a> MessageCmd<'a> {
    pub async fn send(&self, params: SendMessageParams) -> Result<serde_json::Value, CliError>;
    pub async fn poll(&self, params: PollParams) -> Result<serde_json::Value, CliError>;
    pub async fn react(&self, params: ReactParams) -> Result<serde_json::Value, CliError>;
    pub async fn edit(&self, params: EditParams) -> Result<serde_json::Value, CliError>;
    pub async fn delete(&self, params: DeleteParams) -> Result<serde_json::Value, CliError>;
    pub async fn search(&self, params: SearchParams) -> Result<serde_json::Value, CliError>;
    pub async fn broadcast(&self, params: BroadcastParams) -> Result<serde_json::Value, CliError>;
    // ...
}

// ---- commands/channels.rs ----

pub struct ChannelsCmd<'a> {
    cli: &'a OpenClawCli,
}

impl<'a> ChannelsCmd<'a> {
    pub async fn list(&self) -> Result<Vec<ChannelInfo>, CliError>;
    pub async fn status(&self, probe: bool) -> Result<Vec<ChannelStatus>, CliError>;
    pub async fn add(&self, params: ChannelAddParams) -> Result<(), CliError>;
    pub async fn remove(&self, params: ChannelRemoveParams) -> Result<(), CliError>;
    pub async fn capabilities(&self, channel: Option<&str>) -> Result<serde_json::Value, CliError>;
    // ...
}
```

### 3.4 错误类型

```rust
#[derive(Debug, thiserror::Error)]
pub enum CliError {
    /// openclaw 二进制未找到
    #[error("openclaw binary not found: {0}")]
    BinaryNotFound(String),

    /// 子进程执行失败（非零 exit code）
    #[error("command failed (exit {code}): {stderr}")]
    CommandFailed { code: i32, stderr: String },

    /// 子进程超时
    #[error("command timed out after {0:?}")]
    Timeout(Duration),

    /// JSON 输出解析失败
    #[error("failed to parse CLI output: {0}")]
    ParseError(#[from] serde_json::Error),

    /// IO 错误
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}
```

### 3.5 Tauri 集成示例

```rust
// 在 Tauri 应用中使用 SDK
use openclaw_sdk::{OpenClawCli, commands::message::SendMessageParams};

#[tauri::command]
async fn send_message(
    channel: String,
    target: String,
    message: String,
) -> Result<serde_json::Value, String> {
    let cli = OpenClawCli::new().map_err(|e| e.to_string())?;
    cli.message()
        .send(SendMessageParams {
            channel: Some(channel),
            target,
            message: Some(message),
            ..Default::default()
        })
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_channels() -> Result<Vec<ChannelInfo>, String> {
    let cli = OpenClawCli::new().map_err(|e| e.to_string())?;
    cli.channels().list().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn gateway_health() -> Result<GatewayHealth, String> {
    let cli = OpenClawCli::new().map_err(|e| e.to_string())?;
    cli.health().check().await.map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            send_message,
            list_channels,
            gateway_health,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run app");
}
```

## 4. 命令覆盖范围（分期）

### P0 — 核心（Tauri 桌面应用最小可用）

| 命令组 | CLI 命令 | SDK 方法 |
|--------|----------|----------|
| status | `status [--all] [--deep] [--json]` | `cli.status().get()` |
| health | `health [--json]` | `cli.health().check()` |
| channels | `list / status` | `cli.channels().list()` / `.status()` |
| message | `send` | `cli.message().send()` |
| agent | `agent --message` | `cli.agent().run()` |
| gateway | `health / status` | `cli.gateway().health()` / `.status()` |
| config | `get / set` | `cli.config().get()` / `.set()` |

### P1 — 管理面板

| 命令组 | CLI 命令 | SDK 方法 |
|--------|----------|----------|
| models | `status / list / set / scan / auth` | `cli.models().*` |
| agents | `list / add / delete / bind / unbind` | `cli.agents().*` |
| sessions | `list / cleanup` | `cli.sessions().*` |
| devices | `list / approve / reject / remove` | `cli.devices().*` |
| plugins | `list / install / enable / disable` | `cli.plugins().*` |
| logs | `--follow / --limit / --json` | `cli.logs().*` |
| doctor | `[--repair] [--deep]` | `cli.doctor().run()` |

### P2 — 自动化与高级功能

| 命令组 | CLI 命令 | SDK 方法 |
|--------|----------|----------|
| message | `poll / react / edit / delete / search / broadcast` | `cli.message().*` |
| cron | `list / add / edit / rm / enable / disable / run` | `cli.cron().*` |
| hooks | `list / info / enable / disable / install` | `cli.hooks().*` |
| nodes | `list / status / invoke / camera / canvas` | `cli.nodes().*` |
| node | `run / status / install / stop` | `cli.node().*` |
| pairing | `list / approve` | `cli.pairing().*` |
| directory | `self / peers / groups` | `cli.directory().*` |

### P3 — 完整覆盖

| 命令组 | CLI 命令 | SDK 方法 |
|--------|----------|----------|
| browser | `navigate / screenshot / click / type ...` | `cli.browser().*` |
| memory | `status / index / search` | `cli.memory().*` |
| sandbox | `list / recreate` | `cli.sandbox().*` |
| approvals | `get / set / allowlist` | `cli.approvals().*` |
| security | `audit` | `cli.security().audit()` |
| secrets | `reload / audit / configure` | `cli.secrets().*` |
| skills | `list / info / check` | `cli.skills().*` |
| backup | `create / verify` | `cli.backup().*` |
| qr | `[--json]` | `cli.qr().generate()` |
| update | `status / wizard` | `cli.update().*` |
| system | `event / heartbeat / presence` | `cli.system().*` |

## 5. 关键依赖

```toml
[package]
name = "openclaw-sdk"
version = "0.1.0"
edition = "2021"

[dependencies]
tokio = { version = "1", features = ["process", "time", "macros"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
thiserror = "2"
tracing = "0.1"
which = "7"              # 查找 openclaw 二进制路径

[dev-dependencies]
tokio = { version = "1", features = ["full"] }
```

## 6. 设计原则

1. **CLI 子进程模式**：所有操作通过 spawn `openclaw` 子进程实现，SDK 是 CLI 的类型安全包装层
2. **`--json` 优先**：所有支持 `--json` 的命令一律使用该标志，获取结构化输出；不支持的命令 fallback 到原始文本
3. **强类型**：入参使用 builder/params 结构体，出参反序列化为具体类型，编译时发现错误
4. **异步**：基于 `tokio::process`，所有命令调用为 `async fn`，天然适配 Tauri async command
5. **零网络依赖**：SDK 不直接建立任何网络连接，完全依赖本地 CLI 二进制
6. **Tauri 友好**：API 设计考虑 `#[tauri::command]` 集成，返回值均可序列化

## 7. 与现有组件的关系

```
┌─────────────────────────────────────────────────────────────┐
│                      Tauri 桌面应用 (未来)                    │
│  ┌──────────────┐    ┌──────────────────────────────────┐   │
│  │  前端 (Web)   │ ←→ │  Tauri 后端 (Rust)                │   │
│  │  Lit / React  │    │  #[tauri::command] handlers      │   │
│  └──────────────┘    │         ↓                         │   │
│                      │  ┌────────────────────────────┐   │   │
│                      │  │  openclaw-sdk (本 crate)    │   │   │
│                      │  │  OpenClawCli.agent().run()  │   │   │
│                      │  │  OpenClawCli.message().send()│  │   │
│                      │  └────────────┬───────────────┘   │   │
│                      └───────────────┼───────────────────┘   │
│                                      │ spawn                  │
│                               ┌──────▼──────┐                │
│                               │ openclaw CLI │                │
│                               │ (本地二进制)  │                │
│                               └──────┬──────┘                │
│                                      │                        │
│                               ┌──────▼──────┐                │
│                               │   Gateway    │                │
│                               └─────────────┘                │
└─────────────────────────────────────────────────────────────┘
```

- **SDK** 是 CLI 的 Rust 类型包装，不引入额外网络协议
- **Tauri 后端** 通过 SDK 调用 CLI，前端通过 IPC 调用 Tauri command
- 现有 `ui-mqtt` Tauri 应用走 MQTT 路径；新 Tauri 应用走本地 CLI 路径，两者可共存
- SDK 可独立于 Tauri 使用（CI 脚本、测试工具、其他 Rust 项目）
