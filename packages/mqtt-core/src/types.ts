/**
 * Types for MQTT bridge protocol; aligned with ui-mqtt and openclaw-mqtt-bridge.
 */

export interface MqttGatewayResponseFrame {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: string; message: string; details?: unknown };
}

export interface MqttHelloPayload {
  serverVersion?: string;
  assistantName?: string;
  assistantAvatar?: string;
  assistantAgentId?: string;
  snapshot?: unknown;
}

export interface MqttStatusPayload {
  status: "connected" | "disconnected";
  ts: number;
  reason?: string;
}

export interface MqttGatewayEventFrame {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
  stateVersion?: Record<string, number>;
}

export interface ChatEventPayload {
  runId: string;
  sessionKey: string;
  state: "delta" | "final" | "aborted" | "error";
  message?: unknown;
  errorMessage?: string;
}

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
