/**
 * MQTT client for OpenClaw bridge protocol.
 * Topic prefix: openclaw/bridge/{gatewayId}; payloads AES-256-GCM encrypted.
 */

import mqtt, { type MqttClient } from "mqtt";
import { decrypt, encrypt, importKey } from "./crypto.js";
import { generateUUID } from "./uuid.js";
import type {
  MqttGatewayClientOptions,
  MqttGatewayEventFrame,
  MqttGatewayResponseFrame,
  MqttHelloPayload,
  MqttStatusPayload,
} from "./types.js";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
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

export class MqttGatewayClient {
  private client: MqttClient | null = null;
  private cryptoKey: Awaited<ReturnType<typeof importKey>> | null = null;
  private pending = new Map<string, Pending>();
  private prefix: string;
  private closed = false;
  private _connected = false;
  private bridgeConnected = false;
  private lastSeq: number | null = null;
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
    this.cryptoKey = await importKey(this.opts.secretKey);
    const clientId = `openclaw-ui-${Math.random().toString(36).slice(2, 10)}`;
    this.client = mqtt.connect(this.opts.brokerUrl, {
      clientId,
      clean: true,
      connectTimeout: 10_000,
      reconnectPeriod: 5_000,
    });

    this.client.on("connect", () => {
      this._connected = true;
      this.opts.onConnectionChange?.(true);
      const topics = [
        `${this.prefix}/res`,
        `${this.prefix}/event`,
        `${this.prefix}/hello`,
        `${this.prefix}/status`,
      ];
      for (const topic of topics) {
        this.client!.subscribe(topic, { qos: 1 });
      }
    });

    this.client.on("message", (topic: string, payload: Buffer) => {
      const exactBuffer = payload.buffer.slice(
        payload.byteOffset,
        payload.byteOffset + payload.byteLength,
      );
      void this.handleMessage(topic, exactBuffer);
    });

    this.client.on("close", () => {
      this._connected = false;
      this.opts.onConnectionChange?.(false);
      this.opts.onClose?.({ reason: "mqtt connection closed" });
    });

    this.client.on("offline", () => {
      this._connected = false;
      this.opts.onConnectionChange?.(false);
    });

    this.client.on("error", (err: Error) => {
      this.opts.onClose?.({ reason: err.message });
    });
  }

  stop(): void {
    this.closed = true;
    this._connected = false;
    this.bridgeConnected = false;
    this.flushPending(new Error("mqtt gateway client stopped"));
    this.client?.end(true);
    this.client = null;
    this.cryptoKey = null;
  }

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

      void this.publishEncrypted(`${this.prefix}/req`, payload);
    });
  }

  private async handleMessage(topic: string, rawPayload: ArrayBuffer): Promise<void> {
    if (!this.cryptoKey) return;
    const plaintext = await decrypt(rawPayload, this.cryptoKey);
    if (plaintext === null) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(plaintext);
    } catch {
      return;
    }

    if (topic === `${this.prefix}/hello`) {
      this.opts.onHello?.(parsed as MqttHelloPayload);
      return;
    }

    if (topic === `${this.prefix}/status`) {
      const status = parsed as MqttStatusPayload;
      this.bridgeConnected = status.status === "connected";
      this.opts.onStatusChange?.(status);
      return;
    }

    if (topic === `${this.prefix}/res`) {
      const res = parsed as MqttGatewayResponseFrame;
      const pending = this.pending.get(res.id);
      if (!pending) return;
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
      const seq = typeof evt.seq === "number" ? evt.seq : null;
      if (seq !== null) this.lastSeq = seq;
      try {
        this.opts.onEvent?.(evt);
      } catch (err) {
        console.error("[mqtt-gateway] event handler error:", err);
      }
    }
  }

  private async publishEncrypted(topic: string, plaintext: string): Promise<void> {
    if (!this.client || !this.cryptoKey) return;
    const encrypted = await encrypt(plaintext, this.cryptoKey);
    const bytes = new Uint8Array(encrypted);
    const payload =
      typeof Buffer !== "undefined" ? Buffer.from(bytes) : (bytes as unknown as Buffer);
    this.client.publish(topic, payload, { qos: 1 });
  }

  private flushPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
