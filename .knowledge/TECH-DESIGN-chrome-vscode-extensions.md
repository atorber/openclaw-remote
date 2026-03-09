# Chrome / VS Code 扩展 — 详细技术实现方案

本文基于 [PLAN-chrome-vscode-extensions.md](.knowledge/PLAN-chrome-vscode-extensions.md)，给出可指导开发工程师落地的技术设计，包括模块划分、API、数据结构、构建与实现步骤。

---

## 1. 总体架构

```
┌─────────────────────────────────────────────────────────────────┐
│  npm: @atorber/mqtt-core                                         │
│  (packages/mqtt-core 源码，独立发布)                               │
│  - 网关 ID/密钥生成、AES-256-GCM、MQTT 客户端、Chat 协议与类型     │
└─────────────────────────────────────────────────────────────────┘
         │                                    │
         ▼                                    ▼
┌─────────────────────┐            ┌─────────────────────┐
│  apps/chrome        │            │  apps/vscode        │
│  - manifest v3      │            │  - Extension API    │
│  - popup/options    │            │  - Webview + Node   │
│  - chrome.storage   │            │  - workspaceState  │
│  - @atorber/mqtt-core│            │  - @atorber/mqtt-core│
└─────────────────────┘            └─────────────────────┘
         │                                    │
         └──────────────┬─────────────────────┘
                        ▼
              MQTT Broker (e.g. wss://broker.emqx.io:8084/mqtt)
                        │
                        ▼
              openclaw-mqtt-bridge (网关侧，与本文实现无关)
```

---

## 2. Phase 0：@atorber/mqtt-core 技术设计

### 2.1 包信息与入口

| 项目 | 说明 |
|------|------|
| 包名 | `@atorber/mqtt-core` |
| 源码目录 | `openclaw-remote/packages/mqtt-core/` |
| 入口 | `package.json` 的 `"main"` / `"module"` / `"types"` 指向构建产物 |
| 运行环境 | 浏览器（含 Chrome 扩展）、Node.js 18+（VS Code extension host） |

**package.json 要点：**

```json
{
  "name": "@atorber/mqtt-core",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "module": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" }
  },
  "files": ["dist"],
  "dependencies": {
    "mqtt": "^5.12.2"
  },
  "devDependencies": {
    "typescript": "^5.x"
  },
  "engines": { "node": ">=18" }
}
```

- 不依赖 `openclaw`、`ui-mqtt`、`openclaw-mqtt-bridge`。
- 构建输出 ESM + `.d.ts`，供 Chrome（bundle 后）与 VS Code（Node）使用。

### 2.2 目录与文件结构

```
packages/mqtt-core/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              # 统一导出
│   ├── crypto.ts             # 网关 ID/密钥、AES-256-GCM（浏览器 + Node 兼容）
│   ├── client.ts              # MqttGatewayClient
│   ├── uuid.ts                # generateUUID（无 DOM/Node 业务依赖）
│   ├── types.ts               # 所有对外类型
│   ├── session-key.ts         # parseAgentSessionKey
│   └── chat.ts                # Chat 协议常量、extractRawText（可选）
└── dist/                      # 构建产出，不提交或 .gitignore
```

### 2.3 类型定义（types.ts）

以下类型与 ui-mqtt / bridge 约定一致，供调用方与事件回调使用。

```typescript
// types.ts

/** 加密后的请求体：{ id, method, params } 序列化后 AES-GCM 加密 */
// 请求发往 openclaw/bridge/{gatewayId}/req

/** 响应体（解密后）：res topic 下发 */
export interface MqttGatewayResponseFrame {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: string; message: string; details?: unknown };
}

/** hello topic 下发，连接建立后 bridge 推送 */
export interface MqttHelloPayload {
  serverVersion?: string;
  assistantName?: string;
  assistantAvatar?: string;
  assistantAgentId?: string;
  snapshot?: unknown;
}

/** status topic 下发 */
export interface MqttStatusPayload {
  status: "connected" | "disconnected";
  ts: number;
  reason?: string;
}

/** event topic 下发；event === "chat" 时 payload 为 ChatEventPayload */
export interface MqttGatewayEventFrame {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
  stateVersion?: Record<string, number>;
}

/** Chat 事件 payload（evt.event === "chat" 时 evt.payload 即此类型） */
export interface ChatEventPayload {
  runId: string;
  sessionKey: string;
  state: "delta" | "final" | "aborted" | "error";
  message?: unknown;
  errorMessage?: string;
}

/** MqttGatewayClient 构造选项 */
export interface MqttGatewayClientOptions {
  brokerUrl: string;
  gatewayId: string;
  secretKey: string;
  onHello?: (hello: MqttHelloPayload) => void;
  onEvent?: (evt: MqttGatewayEventFrame) => void;
  onClose?: (info: { reason: string }) => void;
  onStatusChange?: (status: MqttStatusPayload) => void;
  onConnectionChange?: (connected: boolean) => void;
  requestTimeoutMs?: number;
}

export interface ParsedAgentSessionKey {
  agentId: string;
  rest: string;
}
```

### 2.4 模块 API 规格

#### 2.4.1 crypto.ts

- **generateGatewayId(): string**  
  返回 `gw-` + 21 位小写字母数字（nanoid 风格），与 ui-mqtt 的 `mqtt-crypto.ts` 一致。
- **generateSecretKey(): string**  
  返回 32 字节随机数的 Base64，与 bridge 端密钥格式一致。
- **importKey(base64Key: string): Promise<CryptoKey>**  
  仅浏览器：用 `crypto.subtle.importKey` 导入 AES-GCM 密钥。Node：可用 `globalThis.crypto.subtle`（Node 19+）或自行用 `node:crypto` 实现等价逻辑并返回与浏览器兼容的“密钥句柄”或在此包内用 Node 专用路径加解密（见下）。
- **encrypt(plaintext: string, key: CryptoKey): Promise<ArrayBuffer>**  
  IV(12B) + ciphertext + tag(16B)，与 bridge 的 node:crypto 格式兼容。
- **decrypt(data: ArrayBuffer, key: CryptoKey): Promise<string | null>**  
  失败返回 null。

**Node 兼容**：若运行在 Node 且无 `crypto.subtle`，可在 crypto.ts 内用 `node:crypto` 的 `createCipheriv`/`createDecipheriv`（AES-256-GCM）实现 encrypt/decrypt；`importKey` 在 Node 可接受 base64 字符串并内部存为 Buffer，加解密时用该 Buffer。为保持 API 一致，可对外仍用 `CryptoKey` 类型，在 Node 下用 `CryptoKey` polyfill 或内部分支：浏览器用 subtle，Node 用 node:crypto。

#### 2.4.2 uuid.ts

- **generateUUID(): string**  
  使用 `crypto.randomUUID()` 或 `crypto.getRandomValues()` 生成 UUID v4，不依赖 DOM。

#### 2.4.3 session-key.ts

- **parseAgentSessionKey(sessionKey: string | undefined | null): ParsedAgentSessionKey | null**  
  解析 `agent:<agentId>:<rest>`，小写化后返回 `{ agentId, rest }`；否则返回 null。

#### 2.4.4 client.ts

- **class MqttGatewayClient**  
  - 构造：`new MqttGatewayClient(opts: MqttGatewayClientOptions)`  
  - **start(): Promise<void>**  
    导入 secretKey、连接 MQTT、订阅 `openclaw/bridge/{gatewayId}/res|event|hello|status`。  
  - **stop(): void**  
    断开并清空 pending。  
  - **request\<T\>(method: string, params?: unknown): Promise<T>**  
    发送 `{ id, method, params }` 到 `.../req`（加密），在 `.../res` 上匹配 id 完成 Promise。  
  - **get connected(): boolean**  
    仅当 MQTT 已连接且收到过 status === "connected" 时为 true。  
- **class MqttGatewayRequestError extends Error**  
  - 属性：gatewayCode: string; details?: unknown。

**Topic 约定（与 bridge 一致）：**

- 前缀：`openclaw/bridge/{gatewayId}`
- 订阅：`{prefix}/res`、`{prefix}/event`、`{prefix}/hello`、`{prefix}/status`
- 发布：`{prefix}/req`（body：上述请求 JSON 的 AES-256-GCM 密文）

#### 2.4.5 chat.ts（可选）

- **CHAT_EVENT_NAME = "chat"**  
  用于判断 `evt.event === "chat"`。
- **extractRawText(message: unknown): string | null**  
  从 message 的 `content`（string 或 array of { type:"text", text }）或 `text` 字段提取纯文本，供 UI 展示；不包含 stripEnvelope/stripThinking 等，各端可按需再处理。
- **chatHistory(client, sessionKey, limit)** / **chatSend(client, sessionKey, message, options?)**  
  可选封装：内部调 `client.request("chat.history", { sessionKey, limit })`、`client.request("chat.send", { sessionKey, message, deliver: false, idempotencyKey, attachments })`，减少调用方拼参错误。

#### 2.4.6 index.ts 导出

```typescript
export { generateGatewayId, generateSecretKey, importKey, encrypt, decrypt } from "./crypto.js";
export { generateUUID } from "./uuid.js";
export { parseAgentSessionKey } from "./session-key.js";
export type { ParsedAgentSessionKey } from "./session-key.js";
export { MqttGatewayClient, MqttGatewayRequestError } from "./client.js";
export type {
  MqttGatewayClientOptions,
  MqttGatewayEventFrame,
  MqttGatewayResponseFrame,
  MqttHelloPayload,
  MqttStatusPayload,
  ChatEventPayload,
} from "./types.js";
export { CHAT_EVENT_NAME, extractRawText } from "./chat.js";
// 可选：chatHistory / chatSend 封装
```

### 2.5 构建

- `tsc` 或 `tsup`：输出 `dist/index.js` + `dist/*.d.ts`，target ES2020+，module NodeNext/ESNext。
- 不 bundle 第三方库（如 `mqtt`），由使用方在各自环境中安装并 bundle 或解析。

### 2.6 实现顺序（开发工程师）

1. 新建 `packages/mqtt-core`，初始化 package.json、tsconfig.json。
2. 实现 `src/uuid.ts`（generateUUID）。
3. 实现 `src/crypto.ts`（generateGatewayId、generateSecretKey、importKey、encrypt、decrypt）；在 Node 下用 `globalThis.crypto` 或 `node:crypto` 做 AES-256-GCM，保证与 ui-mqtt/bridge 的 wire 格式一致。
4. 实现 `src/types.ts`（上述所有接口）。
5. 实现 `src/session-key.ts`（parseAgentSessionKey）。
6. 实现 `src/client.ts`（MqttGatewayClient、MqttGatewayRequestError）；依赖 mqtt、crypto、uuid、types。
7. 实现 `src/chat.ts`（CHAT_EVENT_NAME、extractRawText，可选 chatHistory/chatSend）。
8. 实现 `src/index.ts` 统一导出。
9. 配置构建脚本，执行 `npm run build` 生成 dist。
10. 在仓库根或本包内用简单脚本或单元测试：生成 gatewayId/secretKey、加密解密一轮、连接公共 broker 并收发一条请求（若 broker 支持），验证与 bridge 的兼容性（可后补）。

---

## 3. Phase 1：Chrome 扩展（apps/chrome）技术设计

### 3.1 目录与文件结构

```
apps/chrome/
├── package.json
├── tsconfig.json
├── manifest.json          # manifest_version 3
├── vite.config.ts         # 或 webpack，输出 popup/options 等
├── public/
│   └── icons/             # 扩展图标
├── src/
│   ├── popup/
│   │   ├── popup.html
│   │   ├── popup.ts       # 入口，挂载配置 + 连接状态 + 简单 Chat 区
│   │   └── popup.css
│   ├── options/
│   │   ├── options.html   # 可选：独立配置页
│   │   └── options.ts
│   ├── background/
│   │   └── service-worker.ts   # 仅做消息转发或短生命周期，MQTT 见下
│   ├── lib/
│   │   ├── storage.ts     # 封装 chrome.storage.local（brokerUrl, gatewayId, secretKey, sessionKey）
│   │   ├── connection.ts  # 创建/持有 MqttGatewayClient，从 storage 读配置并 start/stop
│   │   └── chat.ts        # 调 client.request("chat.history"|"chat.send")、处理 onEvent("chat")
│   └── shared/
│       └── types.ts       # 本扩展用到的 UI 状态类型
└── dist/                  # 构建产出，加载到 Chrome 的目录
```

**注意**：Service Worker 生命周期短，不适合长连接 MQTT。推荐将 MQTT 放在 **popup 页面** 或 **offscreen document**（manifest 中声明 offscreen）。用户打开 popup 时建立连接，关闭 popup 时 disconnect；或使用 offscreen 保持连接并在 popup 中通过 messaging 与 offscreen 通信。以下按「popup 内 MQTT」设计，实现简单。

### 3.2 manifest.json 要点

```json
{
  "manifest_version": 3,
  "name": "OpenClaw Remote",
  "version": "0.1.0",
  "permissions": ["storage"],
  "action": { "default_popup": "popup/popup.html", "default_title": "OpenClaw" },
  "optional_host_permissions": ["<all_urls>"]
}
```

- 不强制 content_scripts；若后续需在网页内注入再加。
- 若使用 offscreen，增加 `"offscreen": { "path": "offscreen/offscreen.html", "reason": "..." }`。

### 3.3 存储（lib/storage.ts）

- **key**：如 `openclaw.chrome.settings.v1`。
- **结构**：`{ brokerUrl: string, gatewayId: string, secretKey: string, sessionKey?: string }`。
- **API**：`loadSettings(): Promise<Settings>`、`saveSettings(settings: Settings): Promise<void>`，内部用 `chrome.storage.local.get/set`。

### 3.4 连接（lib/connection.ts）

- **createClient(settings)**：`new MqttGatewayClient({ brokerUrl, gatewayId, secretKey, onHello, onEvent, onClose, onStatusChange, onConnectionChange })`。
- **start(client)**：`client.start()`。
- **stop(client)**：`client.stop()`。
- 连接状态（connected、lastError）通过 onConnectionChange / onHello / onClose 更新到 popup 的 UI 状态（如 React state 或原生 DOM 更新）。

### 3.5 Chat（lib/chat.ts）

- **loadHistory(client, sessionKey)**：`client.request<{ messages?: unknown[]; thinkingLevel?: string }>("chat.history", { sessionKey, limit: 200 })`，返回 messages 列表。
- **sendMessage(client, sessionKey, message, runId)**：`client.request("chat.send", { sessionKey, message, deliver: false, idempotencyKey: runId, attachments?: [] })`。
- **onEvent**：在 connection 的 onEvent 中若 `evt.event === "chat"`，将 `evt.payload` 作为 `ChatEventPayload` 交给 UI：delta 更新流式文本，final/aborted/error 更新消息列表与错误。

### 3.6 Popup UI 行为

1. 打开时从 storage 读取 settings；若 gatewayId/secretKey 为空，显示配置表单（brokerUrl、gatewayId、secretKey），提供「生成新 gatewayId + secretKey」按钮（调用 `@atorber/mqtt-core` 的 generateGatewayId、generateSecretKey），保存到 storage。
2. 若已配置，自动创建 MqttGatewayClient 并 start()；显示连接状态（已连接/未连接/错误）。
3. 已连接时：展示当前 sessionKey 输入框（或固定默认如 `agent:default:main`）、历史消息列表、输入框、发送按钮。发送时调用 sendMessage；onEvent("chat") 时更新列表与流式内容。
4. 关闭 popup 时调用 client.stop()，避免 SW 被杀后悬空连接。

### 3.7 依赖与构建

- **dependencies**：`@atorber/mqtt-core`（版本号与发布一致）、`mqtt`（若 mqtt-core 未 bundle mqtt）。
- **构建**：Vite 以 popup/popup.ts 为入口，输出到 `dist/popup/`；manifest 中 popup 指向 `dist/popup/popup.html`。多入口可配置 popup、options、background。
- **开发**：build 后 Chrome 加载 `dist` 目录为解压扩展，或使用 `web-ext` 等工具。

### 3.8 实现顺序

1. 初始化 apps/chrome（package.json、tsconfig、manifest.json、vite 配置）。
2. 实现 lib/storage.ts。
3. 实现 lib/connection.ts（依赖 @atorber/mqtt-core）。
4. 实现 lib/chat.ts（chat.history、chat.send、事件分支）。
5. 实现 popup UI（配置表单、连接状态、消息列表、输入与发送），与 connection/chat 对接。
6. 联调：配置真实 broker 与 bridge，验证连接与收发消息。

---

## 4. Phase 2：VS Code 扩展（apps/vscode）技术设计

### 4.1 目录与文件结构

```
apps/vscode/
├── package.json
├── tsconfig.json
├── src/
│   ├── extension.ts       # activate 入口，注册命令、Tree、Webview
│   ├── mqtt/
│   │   ├── connection.ts  # 创建/持有 MqttGatewayClient（Node）
│   │   └── chat.ts        # request("chat.history"|"chat.send")、解析 event
│   ├── storage.ts         # 配置持久化：workspaceState 或 globalState 或 configuration
│   ├── webview/
│   │   ├── provider.ts    # WebviewPanel 创建、postMessage 与 extension host 通信
│   │   ├── index.html     # Webview 内页面
│   │   └── script.ts      # Webview 内脚本：只做 UI 与 postMessage，不连 MQTT
│   └── types.ts
├── package.json            # 含 contributes、activationEvents、main
└── .vscodeignore
```

### 4.2 package.json（扩展清单）要点

- **main**：`./dist/extension.js`。
- **contributes**：命令（如 `openclaw.chat`）、配置项（brokerUrl、gatewayId、secretKey）、viewsContainers/views 注册侧边栏。
- **activationEvents**：`onView:openclaw.chat` 或 `onCommand:openclaw.chat`。

### 4.3 配置存储（storage.ts）

- 使用 `workspace.getConfiguration("openclaw")` 或 `context.globalState.get("openclaw.settings")` 存 brokerUrl、gatewayId、secretKey、当前 sessionKey。
- 提供 `getSettings()`、`setSettings(settings)`；「生成新 gatewayId + secretKey」写入配置。

### 4.4 MQTT 在 Node 侧（mqtt/connection.ts、mqtt/chat.ts）

- **connection.ts**：在 extension host 中 `new MqttGatewayClient(...)` 并 start/stop；onHello、onEvent、onClose、onStatusChange 将状态与事件通过 **message 通道** 发给 Webview（见下）。
- **chat.ts**：封装 `client.request("chat.history", ...)`、`client.request("chat.send", ...)`；事件在 connection 的 onEvent 中过滤 `event === "chat"` 后转发给 Webview。

### 4.5 Webview 与 extension host 通信

- **Extension → Webview**：`webviewPanel.webview.postMessage({ type: "connected" | "history" | "chatEvent" | "error", payload })`。
- **Webview → Extension**：`webviewPanel.webview.onDidReceiveMessage(msg => ...)`，msg 如 `{ type: "sendMessage", text, sessionKey }`、`{ type: "loadHistory", sessionKey }`。
- Webview 内仅维护 UI 状态（消息列表、流式文本、连接状态）；不直接使用 @atorber/mqtt-core，所有请求由 extension 完成并回传结果。

### 4.6 Webview 内容

- 单页：连接状态、sessionKey 输入、历史消息列表、输入框、发送按钮。
- 收到 `history` 消息后渲染列表；收到 `chatEvent` 后根据 state（delta/final/aborted/error）更新列表或流式区域。
- 发送：用户点击发送后 postMessage({ type: "sendMessage", text, sessionKey })，extension 调 chat.send 并处理事件再回传。

### 4.7 依赖与构建

- **dependencies**：`@atorber/mqtt-core`、`mqtt`。注意：VS Code 运行在 Node，需确保 mqtt-core 在 Node 下可用（crypto、mqtt 包）。
- **构建**：tsc 编译 extension.ts 等到 dist/；Webview 的 index.html/script 可单独用 Vite 打包成单文件注入，或直接内联脚本。
- **打包**：`vsce package` 产出 .vsix。

### 4.8 实现顺序

1. 初始化 apps/vscode（package.json 扩展清单、tsconfig）。
2. 实现 storage.ts（读写配置）。
3. 实现 mqtt/connection.ts、mqtt/chat.ts（Node 侧 MQTT + Chat）。
4. 实现 extension.ts：注册侧边栏/命令、创建 Webview、在 Webview 与 MQTT 层之间桥接 message。
5. 实现 Webview 页面与脚本（UI + postMessage 协议）。
6. 联调：安装 .vsix，配置 broker 与 bridge，验证连接与 Chat。

---

## 5. Chat 协议速查（与 bridge / ui-mqtt 一致）

| 方法 / 事件 | 说明 |
|-------------|------|
| **chat.history** | params: `{ sessionKey: string, limit?: number }`；返回 `{ messages?: unknown[], thinkingLevel?: string }`。 |
| **chat.send** | params: `{ sessionKey, message: string, deliver?: boolean, idempotencyKey?: string, attachments?: Array<{ type: "image", mimeType: string, content: string }> }`。 |
| **chat.abort** | params: `{ sessionKey, runId?: string }`（可选）。 |
| **event "chat"** | payload: `ChatEventPayload`（runId, sessionKey, state: "delta"\|"final"\|"aborted"\|"error", message?, errorMessage?）。 |

---

## 6. 验收清单

- **@atorber/mqtt-core**：npm 可安装；在 Node 与浏览器环境中均可 require/import；generateGatewayId/generateSecretKey 与现有 bridge 配置兼容；request/response 与 event 与 openclaw-mqtt-bridge 互通。
- **Chrome 扩展**：加载解压扩展后，配置 broker/gatewayId/secretKey 可连接；可拉取历史、发送消息并收到 event 流式/最终结果。
- **VS Code 扩展**：安装 .vsix 后，配置并打开 Chat 视图可连接；可拉取历史、发送消息并收到 event 更新。

本文与 PLAN 一致：四者仅通过 npm 依赖 @atorber/mqtt-core，互不依赖；协议与连接逻辑只维护 mqtt-core 一处。
