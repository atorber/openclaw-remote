# OpenClaw Remote — VS Code Extension

Connect to an OpenClaw gateway via MQTT and chat from the VS Code sidebar.

## Prerequisites

- OpenClaw gateway with **openclaw-mqtt-bridge** installed and configured (same broker, gateway ID, and secret key).
- MQTT broker (e.g. `wss://broker.emqx.io:8084/mqtt`).

## Build

```bash
# From openclaw-remote root: build mqtt-core first
cd packages/mqtt-core && npm run build && cd ../..

# From apps/vscode
npm install
npm run build
```

## Install

- **F5** in VS Code (open this folder as workspace) to run the Extension Development Host.
- Or package: `npx @vscode/vsce package` and install the `.vsix` via **Extensions: Install from VSIX**.

## Usage

1. Open the **OpenClaw** view in the Activity Bar (sidebar).
2. Set **Broker URL**, **Gateway ID**, and **Secret Key** (use **Generate ID + Key** then configure the same in the bridge).
3. Set **Session Key** (e.g. `agent:default:main`).
4. Click **Connect**; when connected, type a message and click **Send**.

Settings can also be edited in **File > Preferences > Settings** under "OpenClaw Remote".
