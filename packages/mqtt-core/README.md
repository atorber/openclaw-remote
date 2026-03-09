# @atorber/mqtt-core

Gateway ID generation, AES-256-GCM crypto, and MQTT client for the OpenClaw remote UI protocol. Used by Chrome extension, VS Code extension, and optionally ui-mqtt / openclaw-mqtt-bridge.

## API

- **generateGatewayId()** — nanoid-style `gw-` + 21 chars
- **generateSecretKey()** — 256-bit random, Base64
- **importKey(base64Key)** — import secret for encrypt/decrypt
- **encrypt(plaintext, key)** / **decrypt(data, key)** — AES-256-GCM (IV 12B + ciphertext + tag 16B)
- **MqttGatewayClient** — connect to broker, subscribe to `openclaw/bridge/{gatewayId}/...`, request/response, hello/status/event
- **CHAT_EVENT_NAME**, **extractRawText(message)** — chat event and message text
- **parseAgentSessionKey(sessionKey)** — parse `agent:agentId:rest`

## Build

```bash
npm install
npm run build
```

Output: `dist/` (ESM + .d.ts).

## Publish

Publish to npm as `@atorber/mqtt-core` when ready; dependents use `"@atorber/mqtt-core": "^0.1.0"` or `"file:../../packages/mqtt-core"` for local development.
