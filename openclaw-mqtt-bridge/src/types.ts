// Shared types for the MQTT bridge plugin.

/** Configuration shape for the MQTT bridge plugin. */
export type MqttBridgeConfig = {
  enabled: boolean;
  mqtt: {
    gatewayId: string;
    secretKey: string;
  };
  auth: {
    token?: string;
    password?: string;
  };
  requestTimeoutMs: number;
};

/** Gateway request frame (client → server). */
export type GatewayRequestFrame = {
  type: "req";
  id: string;
  method: string;
  params?: unknown;
};

/** Gateway response frame (server → client). */
export type GatewayResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
};

/** Gateway event frame (server → client, broadcast). */
export type GatewayEventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
  stateVersion?: Record<string, number>;
};

/** Hello payload published to {prefix}/hello after WS connect. */
export type HelloPayload = {
  serverVersion?: string;
  assistantName?: string;
  assistantAvatar?: string;
  assistantAgentId?: string;
  snapshot?: unknown;
};

/** Status payload published to {prefix}/status. */
export type StatusPayload = {
  status: "connected" | "disconnected";
  ts: number;
  reason?: string;
};

/** MQTT request payload published by ui-mqtt to {prefix}/req. */
export type MqttRequestPayload = {
  id: string;
  method: string;
  params?: unknown;
};

/** Pending request entry in the bridge. */
export type PendingRequest = {
  id: string;
  timer: ReturnType<typeof setTimeout>;
};

/** Minimal logger interface matching PluginLogger. */
export type BridgeLogger = {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};
