/**
 * Minimal assistant text stripping for standalone openclaw-remote.
 * Strips internal scaffolding tags for display; no code-region awareness.
 */

const MEMORY_TAG_RE = /<\s*(\/?)\s*relevant[-_]memories\b[^<>]*>/gi;
const REASONING_TAG_RE =
  /<\s*\/?\s*(?:think(?:ing)?|thought|antthinking|final)\b[^<>]*>/gi;

function stripReasoningTagsSimple(text: string): string {
  if (!text || !REASONING_TAG_RE.test(text)) {
    return text;
  }
  REASONING_TAG_RE.lastIndex = 0;
  return text.replace(REASONING_TAG_RE, "").trimStart();
}

function stripRelevantMemoriesTags(text: string): string {
  if (!text || !/<\s*\/?\s*relevant[-_]memories\b/i.test(text)) {
    return text;
  }
  MEMORY_TAG_RE.lastIndex = 0;
  return text.replace(MEMORY_TAG_RE, "");
}

export function stripAssistantInternalScaffolding(text: string): string {
  const withoutReasoning = stripReasoningTagsSimple(text);
  return stripRelevantMemoriesTags(withoutReasoning).trimStart();
}
