/**
 * Chat history and send via MqttGatewayClient (Node).
 */

import type { MqttGatewayClient } from "@atorber/mqtt-core";

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
