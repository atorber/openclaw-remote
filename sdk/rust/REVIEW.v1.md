# OpenClaw Rust SDK 设计方案 — 架构评审

评审日期：2026-03-11

## 一、关键风险（必须解决）

### 1. 进程启动开销 — 桌面应用体验瓶颈

`openclaw` 是 Node.js 应用，每次 spawn 都有冷启动成本（Node.js 运行时初始化 + 配置加载 + 模块解析）。桌面应用场景下：

- 用户点击「刷新状态」→ spawn 一次 → 等待 200-500ms+
- 用户打开「频道列表」→ 再 spawn 一次
- 连续操作时体感延迟明显

对比：当前 `ui-mqtt` 方案是持久连接，响应在毫秒级。

**建议**：考虑引入 `openclaw gateway call <method> --params <json> --json` 作为核心通道。该命令是对 Gateway WebSocket RPC 的 CLI 封装，可以复用已建立的 Gateway 连接，避免每次命令都重新初始化完整 CLI 上下文。对于高频操作（status/health/message），优先走 `gateway call`。

### 2. 流式命令缺失

当前设计只有 request-response 模型，但多个核心命令是长运行/流式的：

| 命令 | 特征 |
|------|------|
| `openclaw logs --follow` | 持续输出日志行 |
| `openclaw gateway run` | 前台运行 Gateway |
| `openclaw node run` | 前台运行 Node Host |
| `openclaw channels login` | 交互式（等待扫码） |

桌面应用必然需要「实时日志」「Gateway 进程管理」等功能。当前 `exec()` 的 `await stdout 完毕再返回` 模式无法覆盖。

**建议**：增加流式执行层：

```rust
/// 流式命令 — 逐行返回 stdout
pub async fn exec_stream(
    &self,
    args: &[&str],
) -> Result<impl Stream<Item = Result<String, CliError>>, CliError>;

/// 后台进程 — 可取消的长运行命令
pub fn spawn_managed(
    &self,
    args: &[&str],
) -> Result<ManagedProcess, CliError>;

pub struct ManagedProcess {
    pub stdout: tokio::io::Lines<BufReader<ChildStdout>>,
    pub stderr: tokio::io::Lines<BufReader<ChildStderr>>,
    handle: Child,
}

impl ManagedProcess {
    pub async fn kill(&mut self) -> Result<(), CliError>;
    pub fn exit_status(&mut self) -> Option<ExitStatus>;
}
```

### 3. 类型安全是"名义上的"

设计声称强类型，但实际上：

- CLI 的 `--json` 输出没有正式的 JSON Schema，结构随版本变化
- Rust 侧的 `types/` 结构体是人工维护的镜像，没有代码生成保障
- CLI 版本升级后可能出现运行时反序列化失败而非编译时报错

**建议**：

- 短期：在 `types/` 中对所有字段使用 `#[serde(default)]`，容忍字段缺失
- 短期：增加 `#[serde(deny_unknown_fields)]` 的可选严格模式，用于测试时发现 schema 漂移
- 中期：在 openclaw 主仓库导出 JSON Schema，用 `typify` 或 `schematools` 自动生成 Rust 类型

## 二、需要改进的设计点

### 4. CLI 二进制版本耦合

SDK 没有版本协商机制。如果用户安装了旧版 `openclaw`，某些命令可能不存在或 `--json` 输出格式不同。

**建议**：

```rust
impl OpenClawCli {
    /// 初始化时获取 CLI 版本并校验最低版本
    pub async fn new() -> Result<Self, CliError> {
        let version = Self::detect_version(&bin_path).await?;
        if version < MIN_SUPPORTED_VERSION {
            return Err(CliError::VersionTooOld {
                found: version,
                min: MIN_SUPPORTED_VERSION,
            });
        }
        // ...
    }
}
```

### 5. 缺少 OpenClawCli 实例复用设计

当前 Tauri 示例中每个 command 都重建实例：

```rust
// 问题写法：每次调用都重建
#[tauri::command]
async fn send_message(...) -> ... {
    let cli = OpenClawCli::new().map_err(|e| e.to_string())?;
    // ...
}
```

应使用 Tauri 的 State 管理单例：

```rust
// 推荐写法：通过 Tauri State 注入单例
#[tauri::command]
async fn send_message(
    cli: tauri::State<'_, OpenClawCli>,
    channel: String,
    target: String,
    message: String,
) -> Result<serde_json::Value, String> {
    cli.message().send(...).await.map_err(|e| e.to_string())
}
```

### 6. 错误处理粒度不足

stderr 输出是非结构化文本，可能混杂 ANSI 码、进度条残留、警告。当前只有 `CommandFailed { code, stderr }` 一种分类。

**建议**：增加错误分类：

```rust
pub enum CliError {
    // ...现有变体...

    /// CLI 返回了结构化错误（--json 模式下的 error 字段）
    ApiError { code: String, message: String },

    /// 认证问题（exit code 特定值或 stderr 关键字匹配）
    AuthRequired,

    /// Gateway 未运行
    GatewayUnavailable,

    /// CLI 版本过低
    VersionTooOld { found: String, min: String },
}
```

### 7. 安全：环境变量泄露

spawn 子进程默认继承当前进程的全部环境变量。Tauri 应用可能在环境中有敏感信息。

**建议**：

```rust
pub async fn exec(&self, args: &[&str]) -> Result<serde_json::Value, CliError> {
    let mut cmd = Command::new(&self.bin_path);
    cmd.args(args);
    cmd.env_clear();                       // 清空继承
    cmd.envs(self.allowed_env.iter());     // 只传递白名单变量
    // HOME, PATH, OPENCLAW_* 等必要变量
}
```

## 三、值得肯定的设计

| 点 | 说明 |
|----|------|
| 命令组分文件 | `commands/agent.rs` 一文件一组，职责清晰，适合多人并行开发 |
| types 独立目录 | 输入/输出类型与命令逻辑分离，后续可替换为自动生成 |
| 分期交付 | P0-P3 优先级合理，P0 覆盖了桌面应用最小可用集 |
| 依赖极简 | 只有 tokio/serde/thiserror/which，编译快，冲突少 |
| GlobalFlags | `--dev` / `--profile` 全局传递，适配多环境 |

## 四、改进优先级总结

| 优先级 | 改进项 | 工作量 |
|--------|--------|--------|
| **必须** | 增加流式执行层（`exec_stream` + `ManagedProcess`） | 中 |
| **必须** | 增加 CLI 版本检测与最低版本校验 | 小 |
| **必须** | Tauri State 单例模式写入设计文档 | 小 |
| **建议** | 高频操作走 `gateway call` 替代全量 CLI spawn | 中 |
| **建议** | 错误分类细化（Auth / GatewayDown / ApiError） | 小 |
| **建议** | 子进程环境变量白名单 | 小 |
| **建议** | `types/` 字段加 `#[serde(default)]` 防御 schema 漂移 | 小 |
| **远期** | CLI 侧导出 JSON Schema → Rust 类型自动生成 | 大 |

## 五、架构演进建议

当前 CLI 子进程方案作为快速启动是可行的，但如果桌面应用后期对实时性要求提高（消息推送、日志流、状态订阅），建议演进为混合架构：

```
阶段 1（当前）：纯 CLI spawn
    所有操作 → spawn openclaw → 解析 JSON

阶段 2（推荐）：CLI spawn + gateway call
    低频/管理操作 → spawn openclaw（setup/doctor/update/backup...）
    高频/查询操作 → openclaw gateway call（status/health/message/channels...）

阶段 3（远期）：CLI spawn + Gateway WS 直连
    低频/管理操作 → spawn openclaw
    高频/实时操作 → Rust SDK 直连 Gateway WebSocket（零 Node.js 开销）
```
