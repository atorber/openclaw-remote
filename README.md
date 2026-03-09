# OpenClaw Remote

通过 MQTT 与桌面客户端访问 [OpenClaw](https://github.com/openclaw/openclaw) 网关的远程控制与聊天界面。

## 结构

- **openclaw-mqtt-bridge**：OpenClaw 插件，将网关 WebSocket 协议桥接到 MQTT，供远程 UI 使用。
- **ui-mqtt**：基于 Tauri 的桌面应用（OpenClaw Remote），提供控制台与聊天 UI，通过 MQTT 连接网关。

## 前置

- 已安装并运行 OpenClaw 的网关（含 openclaw-mqtt-bridge 插件）。
- Node.js 22+，Rust 工具链（用于 Tauri 构建）。

## 开发

```bash
# 安装 bridge 依赖（在 openclaw 网关环境中安装该插件）
cd openclaw-mqtt-bridge && npm install

# 安装并运行桌面 UI
cd ui-mqtt && npm install && npm run tauri:dev
```

## 构建

```bash
cd ui-mqtt && npm run tauri:build
```

## 许可

MIT（与 OpenClaw 一致）。
