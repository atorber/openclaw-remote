import mqtt from "mqtt";
import type { MqttClient } from "mqtt";
import { decrypt, encrypt, parseSecretKey } from "./crypto.js";
import type {
  BridgeLogger,
  GatewayEventFrame,
  GatewayResponseFrame,
  MqttBridgeConfig,
  MqttRequestPayload,
  PendingRequest,
  StatusPayload,
} from "./types.js";
import { GatewayWsClient } from "./ws-client.js";

const BROKER_URL = "mqtt://broker.emqx.io:1883";

/**
 * MqttBridge orchestrates:
 * - A WS client connected to the local Gateway
 * - An MQTT client connected to the Broker
 * - Bidirectional encrypted forwarding of req/res/event frames
 */
export class MqttBridge {
  private mqttClient: MqttClient | null = null;
  private wsClient: GatewayWsClient | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private key: Buffer;
  private prefix: string;
  private stopped = false;

  constructor(
    private config: MqttBridgeConfig,
    private logger: BridgeLogger,
  ) {
    this.key = parseSecretKey(config.mqtt.secretKey);
    this.prefix = `openclaw/bridge/${config.mqtt.gatewayId}`;
  }

  async start(gatewayPort: number): Promise<void> {
    this.stopped = false;
    const gwUrl = `ws://127.0.0.1:${gatewayPort}`;
    const instanceId = `mqtt-bridge-${randomSuffix()}`;

    this.logger.info(`bridge: starting (gatewayId=${this.config.mqtt.gatewayId})`);

    // 1. Connect to MQTT Broker
    await this.connectMqtt();

    // 2. Connect to Gateway via WS
    this.wsClient = new GatewayWsClient({
      url: gwUrl,
      token: this.config.auth.token,
      password: this.config.auth.password,
      instanceId,
      logger: this.logger,
      onHello: (hello) => {
        this.logger.info(`bridge: gateway connected (server=${hello.serverVersion ?? "unknown"})`);
        // Publish hello to MQTT (retained so late subscribers get it immediately)
        this.publishEncrypted(`${this.prefix}/hello`, JSON.stringify(hello), true);
        // Publish connected status (retained)
        this.publishStatus("connected");
      },
      onResponse: (frame) => {
        // Forward WS response to MQTT
        this.handleWsResponse(frame);
      },
      onEvent: (frame) => {
        // Forward WS event to MQTT
        this.handleWsEvent(frame);
      },
      onClose: (_code, reason) => {
        this.logger.warn(`bridge: gateway ws closed: ${reason}`);
        this.publishStatus("disconnected", reason);
        // Timeout all pending requests — WS is down
        this.timeoutAllPending("gateway disconnected");
      },
    });

    this.wsClient.start();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.logger.info("bridge: stopping");

    // Publish disconnected status before closing
    this.publishStatus("disconnected", "bridge stopping");

    // Clear all pending request timers
    for (const [id, req] of this.pendingRequests) {
      clearTimeout(req.timer);
      this.pendingRequests.delete(id);
    }

    // Stop WS client
    this.wsClient?.stop();
    this.wsClient = null;

    // Disconnect MQTT
    if (this.mqttClient) {
      await new Promise<void>((resolve) => {
        this.mqttClient!.end(false, {}, () => resolve());
      });
      this.mqttClient = null;
    }

    this.logger.info("bridge: stopped");
  }

  private async connectMqtt(): Promise<void> {
    const clientId = `openclaw-bridge-${randomSuffix()}`;
    this.logger.info(`mqtt: connecting to ${BROKER_URL} (clientId=${clientId})`);

    return new Promise<void>((resolve, reject) => {
      this.mqttClient = mqtt.connect(BROKER_URL, {
        clientId,
        clean: true,
        connectTimeout: 10_000,
        reconnectPeriod: 5_000,
      });

      this.mqttClient.on("connect", () => {
        this.logger.info("mqtt: connected to broker");
        // Subscribe to request topic
        const reqTopic = `${this.prefix}/req`;
        this.mqttClient!.subscribe(reqTopic, { qos: 1 }, (err) => {
          if (err) {
            this.logger.error(`mqtt: failed to subscribe to ${reqTopic}: ${String(err)}`);
            reject(err);
          } else {
            this.logger.info(`mqtt: subscribed to ${reqTopic}`);
            resolve();
          }
        });
      });

      this.mqttClient.on("message", (_topic: string, payload: Buffer) => {
        this.handleMqttMessage(_topic, payload);
      });

      this.mqttClient.on("error", (err: Error) => {
        this.logger.error(`mqtt: error: ${err.message}`);
      });

      this.mqttClient.on("offline", () => {
        this.logger.warn("mqtt: broker offline, will reconnect");
      });

      this.mqttClient.on("reconnect", () => {
        this.logger.info("mqtt: reconnecting to broker");
      });
    });
  }

  /** Handle incoming MQTT message on {prefix}/req — forward as WS request. */
  private handleMqttMessage(topic: string, payload: Buffer): void {
    const expectedReqTopic = `${this.prefix}/req`;
    if (topic !== expectedReqTopic) return;

    this.logger.info(`bridge: received MQTT req (${payload.length} bytes)`);

    // Decrypt
    const plaintext = decrypt(payload, this.key);
    if (plaintext === null) {
      this.logger.warn("bridge: failed to decrypt MQTT req (wrong key or corrupted)");
      return;
    }

    this.logger.info(`bridge: decrypted req: ${plaintext.slice(0, 200)}`);

    let req: MqttRequestPayload;
    try {
      req = JSON.parse(plaintext) as MqttRequestPayload;
    } catch {
      this.logger.warn("bridge: invalid JSON in MQTT req");
      return;
    }

    if (!req.id || !req.method) {
      this.logger.warn("bridge: MQTT req missing id or method");
      return;
    }

    this.logger.info(`bridge: forwarding req id=${req.id} method=${req.method}`);

    // Check if WS is connected
    if (!this.wsClient?.connected) {
      this.logger.warn("bridge: WS not connected, replying UNAVAILABLE");
      this.publishEncrypted(
        `${this.prefix}/res`,
        JSON.stringify({
          type: "res",
          id: req.id,
          ok: false,
          error: { code: "UNAVAILABLE", message: "gateway not connected" },
        }),
      );
      return;
    }

    // Set up timeout for this request
    const timer = setTimeout(() => {
      this.pendingRequests.delete(req.id);
      this.publishEncrypted(
        `${this.prefix}/res`,
        JSON.stringify({
          type: "res",
          id: req.id,
          ok: false,
          error: { code: "TIMEOUT", message: "request timeout" },
        }),
      );
    }, this.config.requestTimeoutMs);

    this.pendingRequests.set(req.id, { id: req.id, timer });

    // Forward to Gateway WS
    this.wsClient.sendRequest(req.id, req.method, req.params);
  }

  /** Handle WS response — match pending and forward to MQTT. */
  private handleWsResponse(frame: GatewayResponseFrame): void {
    this.logger.info(`bridge: WS res id=${frame.id} ok=${frame.ok}`);
    const pending = this.pendingRequests.get(frame.id);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingRequests.delete(frame.id);
    }
    // Forward to MQTT regardless (even if no pending — could be from a reconnected session)
    this.publishEncrypted(`${this.prefix}/res`, JSON.stringify(frame));
  }

  /** Handle WS event — forward to MQTT. */
  private handleWsEvent(frame: GatewayEventFrame): void {
    this.publishEncrypted(`${this.prefix}/event`, JSON.stringify(frame));
  }

  /** Publish an encrypted message to an MQTT topic. */
  private publishEncrypted(topic: string, plaintext: string, retain = false): void {
    if (!this.mqttClient?.connected) return;
    const encrypted = encrypt(plaintext, this.key);
    this.mqttClient.publish(topic, encrypted, { qos: 1, retain });
  }

  /** Publish a status message (always retained). */
  private publishStatus(status: "connected" | "disconnected", reason?: string): void {
    const payload: StatusPayload = { status, ts: Date.now(), reason };
    this.publishEncrypted(`${this.prefix}/status`, JSON.stringify(payload), true);
  }

  /** Timeout all pending requests with a given reason. */
  private timeoutAllPending(reason: string): void {
    for (const [id, req] of this.pendingRequests) {
      clearTimeout(req.timer);
      this.publishEncrypted(
        `${this.prefix}/res`,
        JSON.stringify({
          type: "res",
          id,
          ok: false,
          error: { code: "UNAVAILABLE", message: reason },
        }),
      );
    }
    this.pendingRequests.clear();
  }
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}
