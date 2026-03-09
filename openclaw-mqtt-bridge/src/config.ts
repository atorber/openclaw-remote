import type { MqttBridgeConfig } from "./types.js";

/**
 * Parse and validate MQTT bridge configuration from pluginConfig and gateway config.
 * Resolution order: pluginConfig → environment variables → defaults.
 */
export function parseConfig(
  pluginConfig: Record<string, unknown> | undefined,
  gatewayConfig: { gateway?: { auth?: { token?: string; password?: string } } },
): MqttBridgeConfig {
  const cfg = (pluginConfig ?? {}) as Record<string, unknown>;
  const mqttCfg = (cfg.mqtt ?? {}) as Record<string, unknown>;
  const authCfg = (cfg.auth ?? {}) as Record<string, unknown>;

  const enabled = typeof cfg.enabled === "boolean" ? cfg.enabled : true;

  // gatewayId: pluginConfig → env var → fail
  const gatewayId =
    (typeof mqttCfg.gatewayId === "string" && mqttCfg.gatewayId) ||
    process.env.OPENCLAW_MQTT_BRIDGE_GATEWAY_ID ||
    "";

  // secretKey: pluginConfig → env var → fail
  const secretKey =
    (typeof mqttCfg.secretKey === "string" && mqttCfg.secretKey) ||
    process.env.OPENCLAW_MQTT_BRIDGE_SECRET_KEY ||
    "";

  if (enabled && !gatewayId) {
    throw new Error(
      "mqtt-bridge: mqtt.gatewayId is required (set in plugin config or OPENCLAW_MQTT_BRIDGE_GATEWAY_ID env var)",
    );
  }
  if (enabled && !secretKey) {
    throw new Error(
      "mqtt-bridge: mqtt.secretKey is required (set in plugin config or OPENCLAW_MQTT_BRIDGE_SECRET_KEY env var)",
    );
  }

  // Validate secretKey is valid Base64 and 32 bytes
  if (enabled && secretKey) {
    try {
      const keyBytes = Buffer.from(secretKey, "base64");
      if (keyBytes.length !== 32) {
        throw new Error(
          `mqtt-bridge: secretKey must decode to exactly 32 bytes (got ${keyBytes.length}). Generate a 256-bit key.`,
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("mqtt-bridge:")) throw err;
      throw new Error("mqtt-bridge: secretKey is not valid Base64");
    }
  }

  // auth: pluginConfig → gatewayConfig → undefined
  const token =
    (typeof authCfg.token === "string" && authCfg.token) ||
    gatewayConfig.gateway?.auth?.token ||
    undefined;
  const password =
    (typeof authCfg.password === "string" && authCfg.password) ||
    gatewayConfig.gateway?.auth?.password ||
    undefined;

  const requestTimeoutMs =
    typeof cfg.requestTimeoutMs === "number" && cfg.requestTimeoutMs > 0
      ? cfg.requestTimeoutMs
      : 60_000;

  return {
    enabled,
    mqtt: { gatewayId, secretKey },
    auth: { token, password },
    requestTimeoutMs,
  };
}
