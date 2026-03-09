# 方案：Chrome 扩展与 VS Code 扩展（仅网关连接 + Chat）

## 1. 目标与范围

在 **openclaw-remote/apps** 下新增两个独立应用：

| 应用 | 目录 | 说明 |
|------|------|------|
| Chrome 扩展 | `apps/chrome` | 浏览器插件，提供网关连接与聊天 |
| VS Code 扩展 | `apps/vscode` | 编辑器插件，提供网关连接与聊天 |

两者**仅保留**与 ui-mqtt **协议一致**的以下能力，通过依赖 npm 上的 **@atorber/mqtt-core** 复用，无需在各工程内重复实现：

- **网关 ID 生成**：生成并持久化 `gatewayId` + `secretKey`（与 openclaw-mqtt-bridge 一致）。
- **连接功能**：通过 MQTT 连接 broker，与 bridge 的协议（`openclaw/bridge/{gatewayId}/req|res|event|hello|status`），加解密（AES-256-GCM）。
- **Chat 功能**：拉取历史（`chat.history`）、发送消息（`chat.send`）、接收聊天流事件（`event` 中 chat 相关），以及会话键（sessionKey）与消息列表的维护。

**明确不包含的 ui-mqtt 能力**：Tauri 桌面壳、多 Tab 导航、完整设置/配置表单、Cron、Usage 统计、Agents 管理、Channels 配置、Sessions 列表、Exec approval、Logs、Debug 面板、Skills、Nodes、Presence、多语言 i18n、主题、复杂 tool 展示、config-form、各 channel 配置 UI 等。

---

## 2. 独立性原则与共享包

**openclaw-mqtt-bridge**、**ui-mqtt**、**apps/chrome**、**apps/vscode** 为四个**独立**工程：

- 相互**不**依赖：不引用对方源码、不依赖本仓库内其他工程目录。
- 可共同依赖 **npm 上的一个包**：**@atorber/mqtt-core**。协议与连接逻辑只维护这一处，四者通过 `"@atorber/mqtt-core": "^x.y.z"` 使用，各自仍可独立安装、构建、发布。
- **只需维护一个共享包**：@atorber/mqtt-core 独立发版到 npm；bridge / ui-mqtt / chrome / vscode 按需升级版本即可，无需在各工程内重复实现或拷贝协议与加解密逻辑。

---

## 3. 目录与仓库布局

```
openclaw-remote/
├── apps/
│   ├── chrome/          # Chrome 扩展（新建，依赖 @atorber/mqtt-core）
│   ├── vscode/          # VS Code 扩展（新建，依赖 @atorber/mqtt-core）
│   └── flutter/         # 已有
├── packages/
│   └── mqtt-core/       # 源码，发布为 npm 包 @atorber/mqtt-core（仅维护此一处）
├── openclaw-mqtt-bridge/   # 独立，可选依赖 @atorber/mqtt-core
├── ui-mqtt/                # 独立，可选迁移为依赖 @atorber/mqtt-core
└── docs/
    └── PLAN-chrome-vscode-extensions.md
```

- **packages/mqtt-core**：从 ui-mqtt 抽取网关 ID 生成、加解密、MQTT 客户端、Chat 协议与类型；发布到 npm 为 `@atorber/mqtt-core`。Chrome / VS Code（及后续可选的 bridge、ui-mqtt）仅依赖该 npm 包，不依赖本仓库内其他工程。

---

## 4. @atorber/mqtt-core 职责

| 能力 | 内容 |
|------|------|
| 网关 ID / 密钥 | `generateGatewayId()`、`generateSecretKey()`；`importKey`、`encrypt`、`decrypt`（AES-256-GCM） |
| MQTT 客户端 | 与 bridge 约定的 topic、request/response、hello/status/event 订阅与回调 |
| Chat 协议 | `chat.history`、`chat.send` 的调用约定；Chat 事件 payload 类型；sessionKey 解析 |
| 存储 | 不包含；各端用各自存储（localStorage / chrome.storage / VS Code API）持久化配置，再传入 client |

四者通过**同一份** @atorber/mqtt-core 保证协议一致，只需维护这一个 npm 包。

---

## 5. Chrome 扩展方案（apps/chrome）

### 5.1 功能范围

- **配置与连接**：在 popup 或 options 页输入/选择 broker URL、gatewayId、secretKey；支持“生成新 gatewayId + secretKey”；保存到 `chrome.storage.local`（或 sync，按需）。
- **连接状态**：显示已连接/未连接；连接失败时简短错误提示。
- **Chat**：在 popup 或 side panel 中提供单一会话的聊天界面：输入框、发送、历史消息列表、可选流式输出。

### 5.2 技术选型

- **manifest_version 3**。
- 前端：轻量方案（原生 TS + DOM，或 Preact/Lit 等）。
- 打包：Vite 或 Webpack，输出 popup/options/service worker（或 offscreen）等；MQTT 与加解密逻辑使用 **@atorber/mqtt-core**。
- 存储：`chrome.storage.local` 存 brokerUrl、gatewayId、secretKey、当前 sessionKey 等。

### 5.3 与 @atorber/mqtt-core 的集成

- 依赖 npm：`"@atorber/mqtt-core": "^x.y.z"`；从包内引入 MQTT 客户端、`generateGatewayId`、`generateSecretKey` 及类型。
- 连接配置从 `chrome.storage` 读取后传入客户端；连接成功后拉取 `chat.history`、订阅 event 处理 chat 流。不依赖 openclaw-mqtt-bridge、ui-mqtt 或本仓库其他工程。

---

## 6. VS Code 扩展方案（apps/vscode）

### 6.1 功能范围

- **配置与连接**：在设置（settings.json）或扩展的配置视图里配置 broker URL、gatewayId、secretKey；支持“生成新 gatewayId + secretKey”并写入配置；使用 `workspaceState`/`globalState` 或 VS Code 的 configuration API 持久化。
- **连接状态**：在状态栏或侧边栏显示已连接/未连接及错误信息。
- **Chat**：在侧边栏 Webview 或独立 Webview 面板中提供聊天 UI：会话选择（可选，初期可固定一个 sessionKey）、消息列表、输入框、发送、可选流式显示。

### 6.2 技术选型

- **VS Code Extension API**，TypeScript。
- **Webview**：承载聊天 UI；推荐 MQTT 在 **extension host（Node）** 侧建立，通过 `postMessage` 与 Webview 通信。
- **Node 端 MQTT**：extension host 内使用 **@atorber/mqtt-core**；Chat 消息通过 message passing 传到 Webview。

### 6.3 与 @atorber/mqtt-core 的集成

- 依赖 npm：`"@atorber/mqtt-core": "^x.y.z"`；在 extension host 内创建 MQTT 客户端，处理 hello/status/event 和 request/response。
- Chat 历史与发送由 host 调用 `client.request("chat.history"|"chat.send", ...)`，结果与事件经 `Webview.postMessage` 发给 Webview。不依赖 openclaw-mqtt-bridge、ui-mqtt 或本仓库其他工程。

---

## 7. 依赖与构建

- **@atorber/mqtt-core**：单独维护、单独发布到 npm；四者仅通过 npm 依赖该包，不依赖本仓库内其他工程。
- **apps/chrome**、**apps/vscode**：`"@atorber/mqtt-core": "^x.y.z"` + 其他公开包（如 `mqtt`）；可独立安装、构建、发布扩展。
- **openclaw-mqtt-bridge**、**ui-mqtt**：保持独立；可选在后续改为依赖 @atorber/mqtt-core，减少重复实现。

---

## 8. 实施顺序与验收

1. **Phase 0：@atorber/mqtt-core**  
   - 新建 `packages/mqtt-core`，从 ui-mqtt 抽取网关 ID 生成、加解密、MQTT 客户端、Chat 协议与类型；发布到 npm 为 `@atorber/mqtt-core`。  
   - 验收：npm 可安装，Chrome/VS Code 可引用。

2. **Phase 1：Chrome 扩展**  
   - 新建 `apps/chrome`，依赖 @atorber/mqtt-core，实现配置页、连接、Chat UI。  
   - 验收：单独安装/加载扩展，配置 gatewayId/secretKey/broker，连接成功后可收发聊天消息。

3. **Phase 2：VS Code 扩展**  
   - 新建 `apps/vscode`，依赖 @atorber/mqtt-core，实现配置、连接状态、Webview Chat。  
   - 验收：单独安装/调试扩展，配置后连接成功，Webview 中可收发聊天消息。

---

## 9. 风险与注意点

- **Chrome Service Worker**：MQTT 长连接在 SW 中可能受生命周期限制；可考虑把 MQTT 放在 offscreen 或 popup 页面，或短轮询/重连策略。
- **VS Code**：MQTT 在 Node 端，与 Webview 通过 postMessage 通信；协议由 @atorber/mqtt-core 统一保证。
- **维护成本**：协议与连接逻辑只维护 @atorber/mqtt-core 一处，四者升级依赖版本即可。

---

方案评审通过后再按 Phase 0（@atorber/mqtt-core）→ Phase 1（Chrome）→ Phase 2（VS Code）实施；若需调整范围，可在评审时确定。
