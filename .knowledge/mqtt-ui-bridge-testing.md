# MQTT UI Bridge — 测试与调试指南

本文档提供 MQTT UI Bridge 的完整测试与调试步骤，覆盖 Bridge 插件、ui-mqtt 前端、Tauri 桌面端三个阶段。

> **零侵入设计：** Bridge 插件（`openclaw-mqtt-bridge`）作为**第三方扩展**实现，通过 `openclaw/plugin-sdk` 导入类型，不修改核心项目的任何文件（`package.json`、`src/plugin-sdk/` 等均无改动）。npm 包名 `@atorber/openclaw-mqtt-bridge`。

---

## 前置准备

### 1. 安装插件

**方式一：npm 安装（推荐）**

```bash
# 安装插件到 ~/.openclaw/extensions/
openclaw plugins install @atorber/openclaw-mqtt-bridge

# 或手动安装
mkdir -p ~/.openclaw/extensions/openclaw-mqtt-bridge
cd ~/.openclaw/extensions/openclaw-mqtt-bridge
npm init -y && npm install @atorber/openclaw-mqtt-bridge
# 将 node_modules/@atorber/openclaw-mqtt-bridge/ 下的文件复制到当前目录
cp -r node_modules/@atorber/openclaw-mqtt-bridge/* .
npm install --omit=dev --no-package-lock
```

**方式二：开发模式（源码）**

```bash
# 在项目根目录
pnpm install

# bridge 插件依赖可能不完整（pnpm 的 hoist 问题），需单独安装
cd extensions/openclaw-mqtt-bridge && npm install --omit=dev --no-package-lock && cd ../..

# ui-mqtt 不在 pnpm workspace 中，需要单独安装
cd ui-mqtt && npm install --no-package-lock && cd ..
```

### 2. 配置 Gateway

**快捷方式（CLI 命令）：**

```bash
openclaw config set "gateway.controlUi.allowInsecureAuth" true
openclaw config set "plugins.entries.openclaw-mqtt-bridge" '{"enabled": true,"config": {"enabled": true,"mqtt": {"gatewayId": "<your-gateway-id>","secretKey": "<your-secret-key>"}}}'
```

**或手动编辑** `~/.openclaw/openclaw.json`（生产模式）或 `~/.openclaw-dev/openclaw.json`（开发模式）：

```json
{
  "gateway": {
    "controlUi": {
      "allowInsecureAuth": true
    }
  },
  "plugins": {
    "entries": {
      "openclaw-mqtt-bridge": {
        "enabled": true,
        "config": {
          "enabled": true,
          "mqtt": {
            "gatewayId": "<在 ui-mqtt 中生成或自行生成>",
            "secretKey": "<在 ui-mqtt 中生成或自行生成>"
          }
        }
      }
    }
  }
}
```

> **重要：** `gateway.controlUi.allowInsecureAuth: true` 是必需的，bridge 的 WS 客户端使用 token 认证而非 device identity。

**手动生成密钥对（可选，也可在 ui-mqtt 界面中点击 "Generate" 生成）：**

```bash
node -e "
const id = 'gw-' + require('crypto').randomBytes(8).toString('hex');
const key = require('crypto').randomBytes(32).toString('base64');
console.log('gatewayId:', id);
console.log('secretKey:', key);
"
```

两端（bridge 配置 + ui-mqtt 前端）必须使用相同的 `gatewayId` 和 `secretKey`。

---

## Phase 1 测试：Bridge 插件

### 3. 启动 Gateway

**开发模式：**
```bash
pnpm gateway:dev
```

**生产模式：**
```bash
# 需要 Node 22+
openclaw gateway restart
# 查看日志
tail -f /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | grep -o '"1":"[^"]*"'
```

观察日志，应能看到类似：

```
[plugins] openclaw-mqtt-bridge: loaded
bridge: starting (gatewayId=gw-xxxxxxxx)
mqtt: connecting to mqtt://broker.emqx.io:1883
mqtt: connected to broker
mqtt: subscribed to openclaw/bridge/gw-xxxxxxxx/req
openclaw-mqtt-bridge: started
bridge: gateway connected (server=2026.3.7)
```

**故障排查：**

| 日志信息 | 原因 | 解决方式 |
|----------|------|----------|
| `plugin not found: openclaw-mqtt-bridge (stale config entry ignored)` | 插件未安装到正确位置 | 确认 `~/.openclaw/extensions/openclaw-mqtt-bridge/` 存在且有 `index.ts` |
| `Cannot find module '.../plugin-sdk/index.js/core'` | import 路径错误 | 确认 `index.ts` 中 import 为 `openclaw/plugin-sdk`（不是 `/core`） |
| `Cannot find module 'mqtt/build/index.js'` | 插件 node_modules 不完整 | 在插件目录运行 `npm install --omit=dev --no-package-lock` |
| `origin not allowed` | WS 客户端缺少 origin header | 更新 `ws-client.ts`，需添加 `origin: http://127.0.0.1:<port>` |
| `control ui requires device identity` | 缺少 insecure auth 配置 | 添加 `gateway.controlUi.allowInsecureAuth: true` |
| `openclaw-mqtt-bridge: disabled by config` | `enabled` 为 false | 检查配置中 `enabled: true` |
| `mqtt.gatewayId is required` | 缺少 gatewayId | 检查 pluginConfig 配置 |
| `mqtt.secretKey must decode to exactly 32 bytes` | 密钥长度不对 | 重新生成 32 字节密钥 |
| `ws: connect handshake failed` | Gateway 认证失败 | 检查 gateway auth token / password |
| `mqtt: error: ...` | MQTT Broker 不可达 | 检查网络连通性 |

### 4. 用 MQTT 客户端工具验证 bridge 转发

安装 MQTT CLI 工具：

```bash
npm i -g mqtt
```

**4a. 监听 bridge 输出（另一个终端）：**

```bash
mqtt subscribe -h broker.emqx.io -t "openclaw/bridge/<gatewayId>/#" -v
```

应能看到 `hello`、`status` 主题上有二进制消息发布（加密的 payload）。

**4b. 用 Node 脚本测试加解密 + 请求：**

创建 `/tmp/test-bridge.mjs`：

```js
import mqtt from "mqtt";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const GATEWAY_ID = "<你的 gatewayId>";
const SECRET_KEY = "<你的 secretKey base64>";
const key = Buffer.from(SECRET_KEY, "base64");
const prefix = `openclaw/bridge/${GATEWAY_ID}`;

function encrypt(plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, enc, tag]);
}

function decrypt(data) {
  if (data.length < 28) return null;
  try {
    const iv = data.subarray(0, 12);
    const tag = data.subarray(data.length - 16);
    const ct = data.subarray(12, data.length - 16);
    const d = createDecipheriv("aes-256-gcm", key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
  } catch { return null; }
}

const client = mqtt.connect("mqtt://broker.emqx.io:1883");

client.on("connect", () => {
  console.log("connected to broker");
  client.subscribe(`${prefix}/hello`, { qos: 1 });
  client.subscribe(`${prefix}/res`, { qos: 1 });
  client.subscribe(`${prefix}/event`, { qos: 1 });
  client.subscribe(`${prefix}/status`, { qos: 1 });

  setTimeout(() => {
    const req = JSON.stringify({
      id: "test-001",
      method: "sessions.list",
      params: { limit: 5 }
    });
    console.log(">>> publishing req:", req);
    client.publish(`${prefix}/req`, encrypt(req), { qos: 1 });
  }, 2000);
});

client.on("message", (topic, payload) => {
  const plaintext = decrypt(payload);
  const short = topic.replace(prefix + "/", "");
  if (plaintext) {
    console.log(`<<< [${short}]`, JSON.parse(plaintext));
  } else {
    console.log(`<<< [${short}] (decrypt failed, ${payload.length} bytes)`);
  }
});
```

```bash
node /tmp/test-bridge.mjs
```

---

## Phase 2 测试：ui-mqtt 前端

### 5. 启动 ui-mqtt dev server

```bash
cd ui-mqtt
npm run dev
```

Vite dev server 将在 `http://localhost:5173` 启动。

### 6. 浏览器端测试

1. 打开 `http://localhost:5173`
2. 应看到 **MQTT Connection** 设置页面（左侧表单 + 右侧配置预览）
3. 填入：
   - **Gateway ID**: 与 bridge 配置相同的 `gatewayId`
   - **Secret Key**: 与 bridge 配置相同的 `secretKey`
4. 或点击 **Generate Gateway ID** 按钮生成新的一对（需要同步更新 bridge 配置，右侧面板显示完整的 `plugins.entries` JSON，可直接复制到配置文件）
5. 点击 **Connect**

**UI 功能说明：**

- **历史网关下拉框**：连接过的网关会自动保存到 localStorage（最多 10 条），下拉选择可快速切换，每项右侧有 ✕ 删除按钮
- **Secret Key 显示/隐藏**：点击 👁 按钮切换明文/密文显示
- **配置预览面板**：右侧实时显示完整的 `plugins.entries` JSON 配置，一键复制
- **连接超时**：30 秒内未连接成功自动取消并显示 "Connection timeout (30s)"
- **取消连接**：连接中状态显示 "取消" 按钮，可手动中断
- **断开连接**：连接成功后顶栏右侧显示红色 "Disconnect" 按钮，点击返回设置页

**预期行为：**

- 连接成功后，页面跳转到主 UI（Chat / Overview 等标签页）
- 顶栏显示 assistant 名称和版本号（来自 MQTT `hello` 消息）
- 顶栏右侧显示 "Disconnect" 按钮
- 切换标签页应能正常加载数据
- Chat 标签页应能收到 `tick`、`presence` 等事件

**故障排查：**

| 现象 | 原因 | 解决方式 |
|------|------|----------|
| 停留在连接页面 | MQTT Broker 连接失败 | 打开 DevTools Console 查看错误 |
| Connection timeout (30s) | 超时未收到 hello | 检查 bridge 是否在运行、gatewayId 是否匹配 |
| `[mqtt] decrypt failed` | 密钥不匹配或 ArrayBuffer 偏移 | 确认两端 secretKey 一致 |
| `ReferenceError: Buffer` | 浏览器端使用了 Node.js API | 检查 mqtt-gateway-client.ts 中是否用了 `new Uint8Array()` 而非 `Buffer.from()` |
| `process is not defined` | Vite 未处理 MQTT.js | 检查 `vite.config.ts` 中 `define: { "process.env": "{}" }` |
| 无数据但无报错 | secretKey 不匹配，解密静默失败 | 确认两端 secretKey 完全一致 |
| 请求超时 | bridge 侧可能断开 | 检查 gateway 终端日志 |

### 7. 端到端场景验证

| 场景 | 操作 | 预期 |
|------|------|------|
| Hello | 连接后自动 | 顶栏显示版本和 assistant 名称 |
| RPC 请求 | 点击 Sessions 标签 | 会话列表正常加载 |
| RPC 请求 | 点击 Overview 标签 | 概览数据正常显示 |
| 事件推送 | 等待几秒 | 收到 tick/presence 事件（Debug 标签可查看） |
| 聊天 | 发送一条消息 | 消息发送成功，收到回复（需 gateway 配置了 LLM） |
| 断线恢复 | 重启 gateway | ui-mqtt 显示断线，bridge 重连后自动恢复 |
| 历史网关 | 断开后选择历史记录 | 自动填充 gatewayId 和 secretKey |
| 连接超时 | 使用错误的 gatewayId | 30 秒后自动取消并显示超时错误 |
| 手动取消 | 连接中点击取消 | 立即停止连接，回到可编辑状态 |
| 断开连接 | 点击顶栏 Disconnect | 停止 MQTT 客户端，回到设置页 |

### 8. 多实例测试

同时打开两个浏览器标签页到 `http://localhost:5173`，使用相同的 gatewayId + secretKey：

- 两个标签页应独立工作
- 各自的请求通过 `id` 匹配，不会串响应
- 事件（tick/presence）两边都能收到

---

## Phase 3 测试：Tauri 桌面端

### 9. 前提条件

Tauri 2 需要 Rust 工具链：

```bash
# 安装 Rust（如果没有）
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# 安装 Tauri CLI
cargo install tauri-cli
```

### 10. 开发模式运行

```bash
cd ui-mqtt
npm run tauri:dev
```

应弹出 "OpenClaw Remote" 桌面窗口，加载 Vite dev server 内容。行为应与浏览器版一致。

### 11. 打包

```bash
cd ui-mqtt
npm run tauri:build
```

> **注意：** Vite 构建输出到 `ui-mqtt/dist/control-ui/`，Tauri `frontendDist` 配置为 `../dist/control-ui`（相对于 `src-tauri/`），两者必须匹配。

产出平台对应的安装包（macOS `.dmg` / Windows `.msi` / Linux `.deb`）。

---

## 常用调试命令

```bash
# 查看 MQTT 主题下的所有消息（加密的二进制数据，确认消息流）
mqtt subscribe -h broker.emqx.io -t "openclaw/bridge/<gatewayId>/#" -v

# 查看 gateway 日志（生产模式）
tail -f /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | grep -o '"1":"[^"]*"'

# 过滤 bridge 相关日志
tail -f /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | grep -o '"1":"[^"]*"' | grep -i 'bridge\|mqtt\|plugin'

# 查看 gateway 状态
openclaw gateway status

# 检查 gateway 端口
lsof -i :18789

# 检查 MQTT Broker 可达性（TCP）
mqtt connect -h broker.emqx.io -p 1883

# 检查 WebSocket Broker 可达性（浏览器 Console）
new WebSocket("wss://broker.emqx.io:8084/mqtt")

# 查看已安装插件
ls ~/.openclaw/extensions/
```

---

## 关键检查清单

- [ ] 插件安装到 `~/.openclaw/extensions/openclaw-mqtt-bridge/`，含 `index.ts` 和 `node_modules/mqtt/`
- [ ] 插件 `index.ts` 中 import 为 `openclaw/plugin-sdk`（不是 `/core`）
- [ ] `openclaw.json` 中 `plugins.entries.openclaw-mqtt-bridge.enabled: true`
- [ ] `openclaw.json` 中 `gateway.controlUi.allowInsecureAuth: true`
- [ ] Gateway 启动日志中出现 `openclaw-mqtt-bridge: started`
- [ ] Bridge 日志显示 `mqtt: connected to broker` + `bridge: gateway connected`
- [ ] ui-mqtt 中 `npm install` 成功（`mqtt` 依赖已安装）
- [ ] 浏览器 ui-mqtt 能连接并显示主界面
- [ ] 右侧配置面板显示完整 `plugins.entries` JSON
- [ ] 历史网关下拉可选择、可删除
- [ ] 连接超时 30 秒自动取消
- [ ] 取消连接、断开连接按钮正常工作
- [ ] Sessions 列表能正常加载（RPC 请求成功）
- [ ] 所有 MQTT payload 均为密文（Broker 上看到的是二进制数据）
- [ ] 禁用插件后，Gateway + 现有 Control UI 行为完全不变
- [ ] 核心项目零侵入：`package.json` exports、`src/plugin-sdk/` 无任何改动

---

## 架构数据流参考

```
ui-mqtt (浏览器/Tauri)
  │
  │  MQTT over WebSocket (wss://broker.emqx.io:8084/mqtt)
  │  所有 payload 使用 AES-256-GCM 加密
  │  Wire format: IV(12B) + ciphertext + tag(16B)
  │
  ▼
┌─────────────────┐
│  MQTT Broker    │   公共 EMQX Broker
│  (EMQX 公共)    │   仅转发密文，无法解密
└─────────────────┘
  │
  │  MQTT (mqtt://broker.emqx.io:1883)
  │
  ▼
┌────────────────────────────────┐
│  openclaw-mqtt-bridge (插件)    │   运行在 Gateway 进程内
│  - 解密 MQTT req → WS req     │   npm: @atorber/openclaw-mqtt-bridge
│  - WS res/event → 加密 MQTT   │
└────────────────────────────────┘
  │
  │  WebSocket (ws://127.0.0.1:18789)
  │  origin: http://127.0.0.1:18789
  │
  ▼
┌─────────────────────────────┐
│  OpenClaw Gateway           │   现有实现，无改动
│  HTTP + WSS                 │
└─────────────────────────────┘
```

**MQTT 主题结构：**

```
openclaw/bridge/{gatewayId}/
  ├── req      ← ui-mqtt 发布加密请求
  ├── res      → bridge 发布加密响应
  ├── event    → bridge 发布加密事件
  ├── hello    → bridge 连接成功后发布（retained，含 bootstrap 信息）
  └── status   → bridge 发布连接状态（retained，connected/disconnected）
```

**已知注意事项：**

- MQTT.js 浏览器端返回的 `Uint8Array` 可能共享更大的 `ArrayBuffer`，解密时必须用 `payload.buffer.slice(byteOffset, byteOffset + byteLength)`
- 浏览器端无 `Buffer`，发布加密消息使用 `new Uint8Array(encrypted)` 而非 `Buffer.from()`
- `hello` 和 `status` 消息使用 `retain: true` 发布，确保后加入的订阅者能立即收到
