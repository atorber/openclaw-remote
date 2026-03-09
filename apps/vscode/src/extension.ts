/**
 * OpenClaw Remote VS Code extension: register Chat webview and bridge MQTT.
 */

import * as vscode from "vscode";
import { generateGatewayId, generateSecretKey, CHAT_EVENT_NAME } from "@atorber/mqtt-core";
import type { ChatEventPayload } from "@atorber/mqtt-core";
import { getSettings, updateSettings } from "./storage.js";
import {
  createClient,
  getClient,
  startClient,
  stopClient,
} from "./mqtt/connection.js";
import { loadHistory, sendMessage } from "./mqtt/chat.js";
import { getWebviewContent } from "./webview/getHtml.js";

export function activate(context: vscode.ExtensionContext): void {
  let currentSessionKey = "";

  const provider: vscode.WebviewViewProvider = {
    resolveWebviewView(
      webviewView: vscode.WebviewView,
      _webviewResolveContext: vscode.WebviewViewResolveContext,
      _token: vscode.CancellationToken,
    ): void {
      webviewView.webview.options = {
        enableScripts: true,
        localResourceRoots: [],
      };
      webviewView.webview.html = getWebviewContent();

      webviewView.webview.onDidReceiveMessage(async (msg: { type: string; text?: string; brokerUrl?: string; gatewayId?: string; secretKey?: string; sessionKey?: string }) => {
        const config = vscode.workspace.getConfiguration("openclaw");

        if (msg.type === "ready") {
          const s = getSettings(config);
          currentSessionKey = s.sessionKey;
          webviewView.webview.postMessage({
            type: "settings",
            brokerUrl: s.brokerUrl,
            gatewayId: s.gatewayId,
            secretKey: s.secretKey,
            sessionKey: s.sessionKey,
          });
          return;
        }

        if (msg.type === "generate") {
          const gatewayId = generateGatewayId();
          const secretKey = generateSecretKey();
          updateSettings(config, "gatewayId", gatewayId);
          updateSettings(config, "secretKey", secretKey);
          webviewView.webview.postMessage({
            type: "settings",
            brokerUrl: config.get("brokerUrl") || "",
            gatewayId,
            secretKey,
            sessionKey: config.get("sessionKey") || "agent:default:main",
          });
          return;
        }

        if (msg.type === "connect") {
          const brokerUrl = (msg.brokerUrl ?? config.get<string>("brokerUrl"))?.trim() || "wss://broker.emqx.io:8084/mqtt";
          const gatewayId = (msg.gatewayId ?? config.get<string>("gatewayId"))?.trim();
          const secretKey = msg.secretKey ?? config.get<string>("secretKey") ?? "";
          const sessionKey = (msg.sessionKey ?? config.get<string>("sessionKey"))?.trim() || "agent:default:main";
          currentSessionKey = sessionKey;
          if (!gatewayId || !secretKey) {
            webviewView.webview.postMessage({ type: "error", message: "Set Gateway ID and Secret Key." });
            return;
          }
          const settings = { brokerUrl, gatewayId, secretKey, sessionKey };
          const client = createClient(settings, {
            onConnectionChange: (connected) => {
              webviewView.webview.postMessage({ type: connected ? "connected" : "disconnected" });
            },
            onHello: () => {
              webviewView.webview.postMessage({ type: "connected" });
              getClient()
                ?.request("chat.history", { sessionKey, limit: 200 })
                .then((res: unknown) => {
                  const r = res as { messages?: unknown[] };
                  const list = Array.isArray(r?.messages) ? r.messages : [];
                  const msgs = list.map((m: unknown) => {
                    const x = m as { role?: string; content?: { text?: string }[]; text?: string };
                    const text = typeof x.text === "string" ? x.text : (x.content?.[0] as { text?: string } | undefined)?.text ?? "";
                    return { role: (x.role ?? "user").toLowerCase(), text };
                  });
                  webviewView.webview.postMessage({ type: "history", messages: msgs });
                })
                .catch((e: Error) => {
                  webviewView.webview.postMessage({ type: "error", message: String(e) });
                });
            },
            onEvent: (evt) => {
              if (evt.event === CHAT_EVENT_NAME) {
                webviewView.webview.postMessage({ type: "chatEvent", payload: evt.payload as ChatEventPayload });
              }
            },
            onClose: ({ reason }) => {
              webviewView.webview.postMessage({ type: "error", message: reason });
            },
          });
          startClient(client);
          return;
        }

        if (msg.type === "disconnect") {
          stopClient();
          webviewView.webview.postMessage({ type: "disconnected" });
          return;
        }

        if (msg.type === "sendMessage" && typeof msg.text === "string") {
          const client = getClient();
          const sessionKey = currentSessionKey || getSettings(config).sessionKey;
          if (!client?.connected || !sessionKey) {
            webviewView.webview.postMessage({ type: "error", message: "Not connected." });
            return;
          }
          const runId = crypto.randomUUID();
          sendMessage(client, sessionKey, msg.text, runId).catch((e: Error) => {
            webviewView.webview.postMessage({ type: "error", message: String(e) });
          });
        }
      });
    },
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("openclaw.chat", provider),
  );
}

export function deactivate(): void {
  stopClient();
}
