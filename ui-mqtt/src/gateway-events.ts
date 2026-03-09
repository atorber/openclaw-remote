/**
 * Minimal gateway event types for standalone openclaw-remote.
 * Mirrors main repo gateway/events for UI event handling.
 */

export type UpdateAvailable = {
  currentVersion: string;
  latestVersion: string;
  channel: string;
};

export const GATEWAY_EVENT_UPDATE_AVAILABLE = "update.available" as const;

export type GatewayUpdateAvailableEventPayload = {
  updateAvailable: UpdateAvailable | null;
};
