import { clearQueueStaleTimer } from "./app-chat.ts";
import { connectMqttGateway } from "./app-gateway.ts";
import {
  startLogsPolling,
  startNodesPolling,
  stopLogsPolling,
  stopNodesPolling,
  startDebugPolling,
  stopDebugPolling,
} from "./app-polling.ts";
import { observeTopbar, scheduleChatScroll, scheduleLogsScroll } from "./app-scroll.ts";
import {
  applySettingsFromUrl,
  attachThemeListener,
  detachThemeListener,
  inferBasePath,
  syncTabWithLocation,
  syncThemeWithSettings,
} from "./app-settings.ts";
import type { MqttGatewayClient } from "./mqtt-gateway-client.ts";
import type { Tab } from "./navigation.ts";
import type { MqttSettings } from "./views/mqtt-settings.ts";
import { loadMqttSettings } from "./views/mqtt-settings.ts";

type LifecycleHost = {
  basePath: string;
  client?: { stop: () => void } | null;
  mqttClient?: MqttGatewayClient | null;
  mqttSettings: MqttSettings;
  mqttConnecting: boolean;
  mqttConnected: boolean;
  mqttError: string | null;
  connectGeneration: number;
  connected?: boolean;
  tab: Tab;
  assistantName: string;
  assistantAvatar: string | null;
  assistantAgentId: string | null;
  serverVersion: string | null;
  chatHasAutoScrolled: boolean;
  chatManualRefreshInFlight: boolean;
  chatLoading: boolean;
  chatMessages: unknown[];
  chatToolMessages: unknown[];
  chatStream: string;
  logsAutoFollow: boolean;
  logsAtBottom: boolean;
  logsEntries: unknown[];
  popStateHandler: () => void;
  topbarObserver: ResizeObserver | null;
};

export function handleConnected(host: LifecycleHost) {
  ++host.connectGeneration;
  host.basePath = inferBasePath();

  // Load saved MQTT settings
  host.mqttSettings = loadMqttSettings();

  applySettingsFromUrl(host as unknown as Parameters<typeof applySettingsFromUrl>[0]);
  syncTabWithLocation(host as unknown as Parameters<typeof syncTabWithLocation>[0], true);
  syncThemeWithSettings(host as unknown as Parameters<typeof syncThemeWithSettings>[0]);
  attachThemeListener(host as unknown as Parameters<typeof attachThemeListener>[0]);
  window.addEventListener("popstate", host.popStateHandler);

  // MQTT mode: load saved settings but do NOT auto-connect.
  // User must click Connect manually.

  startNodesPolling(host as unknown as Parameters<typeof startNodesPolling>[0]);
  if (host.tab === "logs") {
    startLogsPolling(host as unknown as Parameters<typeof startLogsPolling>[0]);
  }
  if (host.tab === "debug") {
    startDebugPolling(host as unknown as Parameters<typeof startDebugPolling>[0]);
  }
}

const CONNECT_TIMEOUT_MS = 30_000;
let connectTimer: ReturnType<typeof setTimeout> | null = null;

export function clearConnectTimer(): void {
  if (connectTimer) {
    clearTimeout(connectTimer);
    connectTimer = null;
  }
}

export function startMqttConnection(host: LifecycleHost, mqttSettings: MqttSettings) {
  host.mqttConnecting = true;
  host.mqttError = null;

  // Clear any previous timeout
  if (connectTimer) {
    clearTimeout(connectTimer);
    connectTimer = null;
  }

  connectMqttGateway(host as unknown as Parameters<typeof connectMqttGateway>[0], mqttSettings);

  // Start 30s timeout
  connectTimer = setTimeout(() => {
    connectTimer = null;
    if (host.mqttConnecting && !host.mqttConnected) {
      disconnectMqtt(host);
      host.mqttError = "Connection timeout (30s)";
    }
  }, CONNECT_TIMEOUT_MS);
}

export function disconnectMqtt(host: LifecycleHost) {
  if (connectTimer) {
    clearTimeout(connectTimer);
    connectTimer = null;
  }
  // Clear the queue stale timer so it doesn't fire after disconnect
  // and silently reconnect to the old gateway.
  clearQueueStaleTimer();
  host.mqttClient?.stop();
  host.mqttClient = null;
  host.mqttConnecting = false;
  host.mqttConnected = false;
  host.mqttError = null;
  host.connected = false;
  stopNodesPolling(host as unknown as Parameters<typeof stopNodesPolling>[0]);
  stopLogsPolling(host as unknown as Parameters<typeof stopLogsPolling>[0]);
  stopDebugPolling(host as unknown as Parameters<typeof stopDebugPolling>[0]);
}

/** Disconnect then immediately reconnect using stored settings. */
export function reconnectMqtt(host: LifecycleHost) {
  const settings = host.mqttSettings;
  disconnectMqtt(host);
  startMqttConnection(host, settings);
}

export function handleFirstUpdated(host: LifecycleHost) {
  observeTopbar(host as unknown as Parameters<typeof observeTopbar>[0]);
}

export function handleDisconnected(host: LifecycleHost) {
  host.connectGeneration += 1;
  clearQueueStaleTimer();
  window.removeEventListener("popstate", host.popStateHandler);
  stopNodesPolling(host as unknown as Parameters<typeof stopNodesPolling>[0]);
  stopLogsPolling(host as unknown as Parameters<typeof stopLogsPolling>[0]);
  stopDebugPolling(host as unknown as Parameters<typeof stopDebugPolling>[0]);
  host.client?.stop();
  host.client = null;
  host.mqttClient?.stop();
  host.mqttClient = null;
  host.mqttConnected = false;
  host.connected = false;
  detachThemeListener(host as unknown as Parameters<typeof detachThemeListener>[0]);
  host.topbarObserver?.disconnect();
  host.topbarObserver = null;
}

export function handleUpdated(host: LifecycleHost, changed: Map<PropertyKey, unknown>) {
  if (host.tab === "chat" && host.chatManualRefreshInFlight) {
    return;
  }
  if (
    host.tab === "chat" &&
    (changed.has("chatMessages") ||
      changed.has("chatToolMessages") ||
      changed.has("chatStream") ||
      changed.has("chatLoading") ||
      changed.has("tab"))
  ) {
    const forcedByTab = changed.has("tab");
    const forcedByLoad =
      changed.has("chatLoading") && changed.get("chatLoading") === true && !host.chatLoading;
    scheduleChatScroll(
      host as unknown as Parameters<typeof scheduleChatScroll>[0],
      forcedByTab || forcedByLoad || !host.chatHasAutoScrolled,
    );
  }
  if (
    host.tab === "logs" &&
    (changed.has("logsEntries") || changed.has("logsAutoFollow") || changed.has("tab"))
  ) {
    if (host.logsAutoFollow && host.logsAtBottom) {
      scheduleLogsScroll(
        host as unknown as Parameters<typeof scheduleLogsScroll>[0],
        changed.has("tab") || changed.has("logsAutoFollow"),
      );
    }
  }
}
