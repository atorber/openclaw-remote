/**
 * MQTT client lifecycle; uses @atorber/mqtt-core.
 */

import { MqttGatewayClient } from "@atorber/mqtt-core";
import type { Settings } from "./storage.js";
import type { MqttHelloPayload, MqttGatewayEventFrame } from "@atorber/mqtt-core";

export type ConnectionState = {
  connected: boolean;
  error: string | null;
  hello: MqttHelloPayload | null;
};

let client: MqttGatewayClient | null = null;

export function createClient(
  settings: Settings,
  callbacks: {
    onConnectionChange: (connected: boolean) => void;
    onHello: (hello: MqttHelloPayload) => void;
    onEvent: (evt: MqttGatewayEventFrame) => void;
    onClose: (info: { reason: string }) => void;
  },
): MqttGatewayClient {
  stopClient();
  client = new MqttGatewayClient({
    brokerUrl: settings.brokerUrl,
    gatewayId: settings.gatewayId,
    secretKey: settings.secretKey,
    onConnectionChange: callbacks.onConnectionChange,
    onHello: callbacks.onHello,
    onEvent: callbacks.onEvent,
    onClose: callbacks.onClose,
    onStatusChange: (status) => {
      callbacks.onConnectionChange(status.status === "connected");
    },
  });
  return client;
}

export function getClient(): MqttGatewayClient | null {
  return client;
}

export function startClient(c: MqttGatewayClient): void {
  c.start();
}

export function stopClient(): void {
  if (client) {
    client.stop();
    client = null;
  }
}
