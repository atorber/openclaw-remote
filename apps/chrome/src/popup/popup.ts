/**
 * Popup UI: config, connect, chat.
 */

import { generateGatewayId, generateSecretKey } from "@atorber/mqtt-core";
import { loadSettings, saveSettings } from "../lib/storage.js";
import { createClient, getClient, startClient, stopClient } from "../lib/connection.js";
import { loadHistory, sendMessage, isChatEvent } from "../lib/chat.js";
import { extractRawText } from "@atorber/mqtt-core";
import type { ChatEventPayload } from "@atorber/mqtt-core";

const statusEl = document.getElementById("status") as HTMLParagraphElement;
const messageListEl = document.getElementById("message-list") as HTMLDivElement;
const messageInputEl = document.getElementById("message-input") as HTMLInputElement;
const btnSend = document.getElementById("btn-send") as HTMLButtonElement;

let messages: Array<{ role: string; text: string }> = [];
let streamText: string | null = null;

function setStatus(text: string, isError = false): void {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

function renderMessages(): void {
  let html = "";
  for (const m of messages) {
    const safe = escapeHtml(m.text || "");
    html += `<div class="message ${m.role}"><span class="role">${escapeHtml(m.role)}</span><div>${safe}</div></div>`;
  }
  if (streamText) {
    html += `<div class="message assistant"><span class="role">assistant</span><div>${escapeHtml(streamText)}…</div></div>`;
  }
  messageListEl.innerHTML = html || "<div class=\"message\">No messages. Connect and send one.</div>";
  messageListEl.scrollTop = messageListEl.scrollHeight;
}

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function getFormSettings(): { brokerUrl: string; gatewayId: string; secretKey: string; sessionKey: string } {
  return {
    brokerUrl: (document.getElementById("brokerUrl") as HTMLInputElement).value.trim(),
    gatewayId: (document.getElementById("gatewayId") as HTMLInputElement).value.trim(),
    secretKey: (document.getElementById("secretKey") as HTMLInputElement).value,
    sessionKey: (document.getElementById("sessionKey") as HTMLInputElement).value.trim() || "agent:default:main",
  };
}

function setFormSettings(s: { brokerUrl: string; gatewayId: string; secretKey: string; sessionKey: string }): void {
  (document.getElementById("brokerUrl") as HTMLInputElement).value = s.brokerUrl;
  (document.getElementById("gatewayId") as HTMLInputElement).value = s.gatewayId;
  (document.getElementById("secretKey") as HTMLInputElement).value = s.secretKey;
  (document.getElementById("sessionKey") as HTMLInputElement).value = s.sessionKey;
}

async function onConnect(): Promise<void> {
  const form = getFormSettings();
  if (!form.gatewayId || !form.secretKey) {
    setStatus("Set Gateway ID and Secret Key first.", true);
    return;
  }
  await saveSettings(form);
  setStatus("Connecting…");
  const client = createClient(
    form,
    {
      onConnectionChange: (connected) => {
        setStatus(connected ? "Connected" : "Disconnected");
      },
      onHello: () => {
        setStatus("Connected");
        void loadMessages();
      },
      onEvent: (evt) => {
        if (isChatEvent(evt)) {
          handleChatEvent(evt.payload as ChatEventPayload | undefined, form.sessionKey);
        }
      },
      onClose: ({ reason }) => {
        setStatus(`Closed: ${reason}`, true);
      },
    },
  );
  startClient(client);
}

function handleChatEvent(payload: ChatEventPayload | undefined, sessionKey: string): void {
  if (!payload || payload.sessionKey !== sessionKey) return;
  if (payload.state === "delta") {
    const text = extractRawText(payload.message);
    if (typeof text === "string") {
      streamText = (streamText ?? "") + text;
      renderMessages();
    }
  } else if (payload.state === "final" || payload.state === "aborted") {
    const text = extractRawText(payload.message);
    if (typeof text === "string" && text.trim()) {
      messages.push({ role: "assistant", text: text.trim() });
    } else if (streamText?.trim()) {
      messages.push({ role: "assistant", text: streamText.trim() });
    }
    streamText = null;
    renderMessages();
  } else if (payload.state === "error") {
    streamText = null;
    setStatus(payload.errorMessage ?? "Chat error", true);
    renderMessages();
  }
}

async function loadMessages(): Promise<void> {
  const client = getClient();
  const form = getFormSettings();
  if (!client?.connected || !form.sessionKey) return;
  try {
    const { messages: list } = await loadHistory(client, form.sessionKey);
    messages = (list as Array<{ role?: string; content?: unknown; text?: string }>)
      .map((m) => ({
        role: (m.role ?? "user").toLowerCase(),
        text: typeof m.text === "string" ? m.text : extractRawText(m) ?? "",
      }))
      .filter((m) => m.text);
    renderMessages();
  } catch (e) {
    setStatus(String(e), true);
  }
}

async function onSend(): Promise<void> {
  const client = getClient();
  const form = getFormSettings();
  const text = messageInputEl.value.trim();
  if (!client?.connected || !form.sessionKey || !text) return;
  messages.push({ role: "user", text });
  messageInputEl.value = "";
  renderMessages();
  const runId = crypto.randomUUID();
  try {
    await sendMessage(client, form.sessionKey, text, runId);
    streamText = "";
    renderMessages();
  } catch (e) {
    setStatus(String(e), true);
    messages.pop();
    renderMessages();
  }
}

function onGenerate(): void {
  const gatewayId = generateGatewayId();
  const secretKey = generateSecretKey();
  (document.getElementById("gatewayId") as HTMLInputElement).value = gatewayId;
  (document.getElementById("secretKey") as HTMLInputElement).value = secretKey;
  setStatus("Generated. Save and configure the same in OpenClaw bridge.");
}

function onDisconnect(): void {
  stopClient();
  setStatus("Disconnected");
}

async function init(): Promise<void> {
  const settings = await loadSettings();
  setFormSettings(settings);
  setStatus("Configure and connect.");

  document.getElementById("btn-generate")?.addEventListener("click", onGenerate);
  document.getElementById("btn-save")?.addEventListener("click", async () => {
    await saveSettings(getFormSettings());
    setStatus("Saved.");
  });
  document.getElementById("btn-connect")?.addEventListener("click", () => void onConnect());
  document.getElementById("btn-disconnect")?.addEventListener("click", onDisconnect);
  btnSend.addEventListener("click", () => void onSend());
  messageInputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void onSend();
  });
}

init();
