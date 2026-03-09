/**
 * Chat history and send via MqttGatewayClient.
 */

import type { MqttGatewayClient } from "@atorber/mqtt-core";
import { CHAT_EVENT_NAME } from "@atorber/mqtt-core";
import type { ChatEventPayload } from "@atorber/mqtt-core";

export interface ChatHistoryResult {
  messages: unknown[];
  thinkingLevel: string | null;
}

export async function loadHistory(
  client: MqttGatewayClient,
  sessionKey: string,
  limit = 200,
): Promise<ChatHistoryResult> {
  const res = await client.request<{ messages?: unknown[]; thinkingLevel?: string }>(
    "chat.history",
    { sessionKey, limit },
  );
  return {
    messages: Array.isArray(res.messages) ? res.messages : [],
    thinkingLevel: res.thinkingLevel ?? null,
  };
}

export async function sendMessage(
  client: MqttGatewayClient,
  sessionKey: string,
  message: string,
  runId: string,
): Promise<void> {
  await client.request("chat.send", {
    sessionKey,
    message: message.trim(),
    deliver: false,
    idempotencyKey: runId,
  });
}

export function isChatEvent(evt: { event: string }): evt is { event: typeof CHAT_EVENT_NAME; payload?: ChatEventPayload } {
  return evt.event === CHAT_EVENT_NAME;
}
