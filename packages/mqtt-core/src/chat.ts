/**
 * Chat protocol helpers: event name and raw text extraction from messages.
 */

export const CHAT_EVENT_NAME = "chat";

/**
 * Extract plain text from a chat message (content array or text field).
 * Does not strip envelope/thinking; UI may post-process.
 */
export function extractRawText(message: unknown): string | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  const m = message as Record<string, unknown>;
  const content = m.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts = (content as Array<{ type?: string; text?: string }>)
      .map((p) => (p?.type === "text" && typeof p.text === "string" ? p.text : null))
      .filter((v): v is string => typeof v === "string");
    if (parts.length > 0) {
      return parts.join("\n");
    }
  }
  if (typeof m.text === "string") {
    return m.text;
  }
  return null;
}
