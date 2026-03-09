/**
 * MqttGatewayClient — replacement for GatewayBrowserClient.
 * Communicates with the Gateway entirely via MQTT topics through the bridge plugin.
 * All payloads are encrypted with AES-256-GCM end-to-end.
 */

import mqtt from "mqtt";
import type { MqttClient } from "mqtt";
import { decrypt, encrypt, importKey } from "./mqtt-crypto.ts";
import { generateUUID } from "./uuid.ts";

export type MqttGatewayEventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
  stateVersion?: Record<string, number>;
};

export type MqttGatewayResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: string; message: string; details?: unknown };
};

export type MqttHelloPayload = {
  serverVersion?: string;
  assistantName?: string;
  assistantAvatar?: string;
  assistantAgentId?: string;
  snapshot?: unknown;
};

export type MqttStatusPayload = {
  status: "connected" | "disconnected";
  ts: number;
  reason?: string;
};

export type MqttGatewayClientOptions = {
  brokerUrl: string;
  gatewayId: string;
  secretKey: string;
  onHello?: (hello: MqttHelloPayload) => void;
  onEvent?: (evt: MqttGatewayEventFrame) => void;
  onClose?: (info: { reason: string }) => void;
  onStatusChange?: (status: MqttStatusPayload) => void;
  onConnectionChange?: (connected: boolean) => void;
  requestTimeoutMs?: number;
};

export class MqttGatewayRequestError extends Error {
  readonly gatewayCode: string;
  readonly details?: unknown;

  constructor(error: { code: string; message: string; details?: unknown }) {
    super(error.message);
    this.name = "MqttGatewayRequestError";
    this.gatewayCode = error.code;
    this.details = error.details;
  }
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class MqttGatewayClient {
  private client: MqttClient | null = null;
  private cryptoKey: CryptoKey | null = null;
  private pending = new Map<string, Pending>();
  private prefix: string;
  private closed = false;
  private _connected = false;
  private bridgeConnected = false;
  private lastSeq: number | null = null;
  private helloReceived = false;
  private timeoutMs: number;

  constructor(private opts: MqttGatewayClientOptions) {
    this.prefix = `openclaw/bridge/${opts.gatewayId}`;
    this.timeoutMs = opts.requestTimeoutMs ?? 60_000;
  }

  get connected(): boolean {
    return this._connected && this.bridgeConnected;
  }

  async start(): Promise<void> {
    this.closed = false;
    this.helloReceived = false;

    // Import the encryption key
    console.log("[mqtt] importing secret key...");
    this.cryptoKey = await importKey(this.opts.secretKey);
    console.log("[mqtt] secret key imported OK");

    // Connect to MQTT broker
    const clientId = `openclaw-ui-${randomSuffix()}`;
    console.log(`[mqtt] connecting to ${this.opts.brokerUrl} (clientId=${clientId})`);
    this.client = mqtt.connect(this.opts.brokerUrl, {
      clientId,
      clean: true,
      connectTimeout: 10_000,
      reconnectPeriod: 5_000,
    });

    this.client.on("connect", () => {
      console.log("[mqtt] connected to broker");
      this._connected = true;
      this.opts.onConnectionChange?.(true);
      // Subscribe to all response/event/hello/status topics
      const topics = [
        `${this.prefix}/res`,
        `${this.prefix}/event`,
        `${this.prefix}/hello`,
        `${this.prefix}/status`,
      ];
      for (const topic of topics) {
        this.client!.subscribe(topic, { qos: 1 });
      }
      console.log("[mqtt] subscribed to topics:", topics);
    });

    this.client.on("message", (topic: string, payload: Buffer) => {
      console.log(`[mqtt] message on ${topic} (${payload.length} bytes)`);
      // MQTT.js may return a Uint8Array backed by a larger ArrayBuffer.
      // Slice to get an exact-length ArrayBuffer for Web Crypto.
      const exactBuffer = payload.buffer.slice(
        payload.byteOffset,
        payload.byteOffset + payload.byteLength,
      );
      void this.handleMessage(topic, exactBuffer);
    });

    this.client.on("close", () => {
      console.log("[mqtt] connection closed");
      this._connected = false;
      this.opts.onConnectionChange?.(false);
      this.opts.onClose?.({ reason: "mqtt connection closed" });
    });

    this.client.on("offline", () => {
      console.log("[mqtt] broker offline");
      this._connected = false;
      this.opts.onConnectionChange?.(false);
    });

    this.client.on("error", (err: Error) => {
      console.error("[mqtt] error:", err.message);
    });
  }

  stop(): void {
    debugLog("stop");
    this.closed = true;
    this._connected = false;
    this.bridgeConnected = false;
    this.flushPending(new Error("mqtt gateway client stopped"));
    this.client?.end(true);
    this.client = null;
    this.cryptoKey = null;
  }

  /** Send an RPC request via MQTT and return the response. */
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.client || !this._connected || !this.cryptoKey) {
      return Promise.reject(new Error("mqtt gateway not connected"));
    }

    const id = generateUUID();
    const payload = JSON.stringify({ id, method, params: params ?? {} });

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new MqttGatewayRequestError({
            code: "TIMEOUT",
            message: `request timeout after ${this.timeoutMs}ms`,
          }),
        );
      }, this.timeoutMs);

      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      });

      debugLog("send request", { method, id, topic: `${this.prefix}/req` });
      void this.publishEncrypted(`${this.prefix}/req`, payload);
    });
  }

  private async handleMessage(topic: string, rawPayload: ArrayBuffer): Promise<void> {
    if (!this.cryptoKey) {
      return;
    }

    // Decrypt the payload
    const plaintext = await decrypt(rawPayload, this.cryptoKey);
    if (plaintext === null) {
      console.warn(`[mqtt] decrypt failed for ${topic} (${rawPayload.byteLength} bytes)`);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(plaintext);
    } catch {
      console.warn(`[mqtt] invalid JSON after decrypt for ${topic}`);
      return;
    }

    if (topic === `${this.prefix}/hello`) {
      console.log("[mqtt] received hello:", JSON.stringify(parsed).slice(0, 200));
      this.helloReceived = true;
      this.opts.onHello?.(parsed as MqttHelloPayload);
      return;
    }

    if (topic === `${this.prefix}/status`) {
      const status = parsed as MqttStatusPayload;
      debugLog("received status", status.status, status.reason ?? "");
      this.bridgeConnected = status.status === "connected";
      this.opts.onStatusChange?.(status);
      return;
    }

    if (topic === `${this.prefix}/res`) {
      const res = parsed as MqttGatewayResponseFrame;
      debugLog("received res", { id: res.id, ok: res.ok });
      const pending = this.pending.get(res.id);
      if (!pending) {
        return;
      } // Not our request
      clearTimeout(pending.timer);
      this.pending.delete(res.id);
      if (res.ok) {
        pending.resolve(res.payload);
      } else {
        pending.reject(
          new MqttGatewayRequestError({
            code: res.error?.code ?? "UNAVAILABLE",
            message: res.error?.message ?? "request failed",
            details: res.error?.details,
          }),
        );
      }
      return;
    }

    if (topic === `${this.prefix}/event`) {
      const evt = parsed as MqttGatewayEventFrame;
      // Sequence gap detection
      const seq = typeof evt.seq === "number" ? evt.seq : null;
      if (seq !== null && this.lastSeq !== null && seq > this.lastSeq + 1) {
        console.warn(`[mqtt-gateway] event gap: expected seq ${this.lastSeq + 1}, got ${seq}`);
      }
      if (seq !== null) {
        this.lastSeq = seq;
      }
      try {
        this.opts.onEvent?.(evt);
      } catch (err) {
        console.error("[mqtt-gateway] event handler error:", err);
      }
    }
  }

  private async publishEncrypted(topic: string, plaintext: string): Promise<void> {
    if (!this.client || !this.cryptoKey) {
      return;
    }
    const encrypted = await encrypt(plaintext, this.cryptoKey);
    debugLog("publish", { topic, plainLen: plaintext.length, encryptedLen: encrypted.byteLength });
    this.client.publish(topic, new Uint8Array(encrypted), { qos: 1 });
  }

  private flushPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Enable in browser console: localStorage.setItem("openclaw_mqtt_debug", "1") */
function mqttDebug(): boolean {
  try {
    return localStorage.getItem("openclaw_mqtt_debug") === "1";
  } catch {
    return false;
  }
}

function debugLog(...args: unknown[]): void {
  if (mqttDebug()) {
    console.log("[mqtt-gateway]", ...args);
  }
}
