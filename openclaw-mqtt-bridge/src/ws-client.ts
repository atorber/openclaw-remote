import WebSocket from "ws";
import type {
  BridgeLogger,
  GatewayEventFrame,
  GatewayResponseFrame,
  HelloPayload,
} from "./types.js";

export type WsClientOptions = {
  url: string;
  token?: string;
  password?: string;
  instanceId: string;
  logger: BridgeLogger;
  onHello: (hello: HelloPayload, raw: unknown) => void;
  onResponse: (frame: GatewayResponseFrame) => void;
  onEvent: (frame: GatewayEventFrame) => void;
  onClose: (code: number, reason: string) => void;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
};

/**
 * Server-side WebSocket client for the Gateway.
 * Handles the connect.challenge → connect handshake using token/password auth
 * (no device identity — bridge runs server-side without crypto.subtle).
 */
export class GatewayWsClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private closed = false;
  private connectNonce: string | null = null;
  private connectSent = false;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 1000;
  private idCounter = 0;

  constructor(private opts: WsClientOptions) {}

  start() {
    this.closed = false;
    this.connect();
  }

  stop() {
    this.closed = true;
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.flushPending(new Error("bridge ws client stopped"));
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Send a request frame to the Gateway and return the response payload. */
  sendRequest(id: string, method: string, params?: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const frame = JSON.stringify({ type: "req", id, method, params: params ?? {} });
    this.ws.send(frame);
  }

  private connect() {
    if (this.closed) return;

    this.opts.logger.info(`ws: connecting to ${this.opts.url}`);
    this.ws = new WebSocket(this.opts.url, {
      origin: `http://127.0.0.1:${new URL(this.opts.url).port}`,
    });

    this.ws.on("open", () => {
      this.opts.logger.info("ws: connected, waiting for connect.challenge");
      this.queueConnect();
    });

    this.ws.on("message", (data: WebSocket.Data) => {
      this.handleMessage(String(data));
    });

    this.ws.on("close", (code: number, reason: Buffer) => {
      const reasonStr = reason.toString();
      this.ws = null;
      this.flushPending(new Error(`ws closed (${code}): ${reasonStr}`));
      this.opts.onClose(code, reasonStr);
      this.scheduleReconnect();
    });

    this.ws.on("error", (err: Error) => {
      this.opts.logger.warn(`ws error: ${err.message}`);
      // close event will fire after error
    });
  }

  private scheduleReconnect() {
    if (this.closed) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    this.opts.logger.info(`ws: reconnecting in ${delay}ms`);
    setTimeout(() => this.connect(), delay);
  }

  private flushPending(err: Error) {
    for (const [, p] of this.pending) {
      p.reject(err);
    }
    this.pending.clear();
  }

  private queueConnect() {
    this.connectNonce = null;
    this.connectSent = false;
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
    }
    // Fallback: if no challenge arrives within 750ms, send connect anyway
    this.connectTimer = setTimeout(() => {
      void this.sendConnect();
    }, 750);
  }

  private sendConnect() {
    if (this.connectSent) return;
    this.connectSent = true;
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }

    const auth =
      this.opts.token || this.opts.password
        ? { token: this.opts.token, password: this.opts.password }
        : undefined;

    const params = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: "openclaw-control-ui",
        version: "mqtt-bridge",
        platform: "node",
        mode: "ui",
        instanceId: this.opts.instanceId,
      },
      role: "operator",
      scopes: ["operator.admin", "operator.approvals", "operator.pairing"],
      caps: [],
      auth,
    };

    // Send the connect request via the internal request mechanism
    const id = this.nextId();
    const frame = JSON.stringify({ type: "req", id, method: "connect", params });
    this.ws?.send(frame);

    // Track as pending so we can handle the hello-ok response
    const p = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });

    p.then((payload) => {
      this.backoffMs = 1000; // reset backoff on successful connect
      const hello = payload as Record<string, unknown> | undefined;
      const server = hello?.server as Record<string, unknown> | undefined;
      const snapshot = hello?.snapshot;

      const helloPayload: HelloPayload = {
        serverVersion: typeof server?.version === "string" ? server.version : undefined,
        assistantName: extractAssistantName(snapshot),
        assistantAvatar: "",
        assistantAgentId: extractAssistantAgentId(snapshot),
        snapshot,
      };

      this.opts.onHello(helloPayload, payload);
    }).catch((err: unknown) => {
      this.opts.logger.error(`ws: connect handshake failed: ${String(err)}`);
      this.ws?.close(4008, "connect failed");
    });
  }

  private handleMessage(raw: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const frame = parsed as { type?: unknown };

    if (frame.type === "event") {
      const evt = parsed as GatewayEventFrame;

      // Handle connect.challenge during handshake
      if (evt.event === "connect.challenge") {
        const payload = evt.payload as { nonce?: unknown } | undefined;
        const nonce = typeof payload?.nonce === "string" ? payload.nonce : null;
        if (nonce) {
          this.connectNonce = nonce;
          void this.sendConnect();
        }
        return;
      }

      this.opts.onEvent(evt);
      return;
    }

    if (frame.type === "res") {
      const res = parsed as GatewayResponseFrame;
      const pending = this.pending.get(res.id);
      if (pending) {
        this.pending.delete(res.id);
        if (res.ok) {
          pending.resolve(res.payload);
        } else {
          pending.reject(new Error(res.error?.message ?? "request failed"));
        }
        return;
      }

      // No pending match — this is a response to a forwarded request from MQTT
      this.opts.onResponse(res);
    }
  }

  private nextId(): string {
    return `bridge-${++this.idCounter}-${Date.now()}`;
  }
}

/** Extract assistant name from the hello-ok snapshot. */
function extractAssistantName(snapshot: unknown): string | undefined {
  if (!snapshot || typeof snapshot !== "object") return undefined;
  const s = snapshot as Record<string, unknown>;
  const defaults = s.sessionDefaults as Record<string, unknown> | undefined;
  if (typeof defaults?.assistantName === "string") return defaults.assistantName;
  return undefined;
}

/** Extract assistant agent ID from the hello-ok snapshot. */
function extractAssistantAgentId(snapshot: unknown): string | undefined {
  if (!snapshot || typeof snapshot !== "object") return undefined;
  const s = snapshot as Record<string, unknown>;
  const defaults = s.sessionDefaults as Record<string, unknown> | undefined;
  if (typeof defaults?.agentId === "string") return defaults.agentId;
  return undefined;
}
