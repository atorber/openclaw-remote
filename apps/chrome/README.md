# OpenClaw Remote — Chrome Extension

Connect to an OpenClaw gateway via MQTT and chat from the browser.

## Prerequisites

- OpenClaw gateway with **openclaw-mqtt-bridge** installed and configured (same broker, gateway ID, and secret key).
- MQTT broker (e.g. `wss://broker.emqx.io:8084/mqtt`).

## Build

```bash
# From openclaw-remote root: build mqtt-core first
cd packages/mqtt-core && npm run build && cd ../..

# From apps/chrome
npm install
npm run build
```

## Load in Chrome

1. Open `chrome://extensions/`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the `apps/chrome/dist` directory.

## Usage

1. Click the extension icon in the toolbar to open the **right-side panel**.
2. In the panel, set **Broker URL**, **Gateway ID**, and **Secret Key** (use **Generate new ID + Key** then configure the same in the bridge).
3. Click **Save**, then **Connect**.
4. Set **Session Key** (e.g. `agent:default:main`) and send messages.
