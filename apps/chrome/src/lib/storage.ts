/**
 * Chrome extension settings via chrome.storage.local.
 */

export interface Settings {
  brokerUrl: string;
  gatewayId: string;
  secretKey: string;
  sessionKey: string;
}

const STORAGE_KEY = "openclaw.chrome.settings.v1";

const DEFAULTS: Settings = {
  brokerUrl: "wss://broker.emqx.io:8084/mqtt",
  gatewayId: "",
  secretKey: "",
  sessionKey: "agent:default:main",
};

export function loadSettings(): Promise<Settings> {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEY, (result) => {
      const raw = result[STORAGE_KEY];
      if (!raw || typeof raw !== "object") {
        resolve({ ...DEFAULTS });
        return;
      }
      const o = raw as Partial<Settings>;
      resolve({
        brokerUrl: typeof o.brokerUrl === "string" && o.brokerUrl.trim() ? o.brokerUrl.trim() : DEFAULTS.brokerUrl,
        gatewayId: typeof o.gatewayId === "string" ? o.gatewayId.trim() : DEFAULTS.gatewayId,
        secretKey: typeof o.secretKey === "string" ? o.secretKey : DEFAULTS.secretKey,
        sessionKey: typeof o.sessionKey === "string" && o.sessionKey.trim() ? o.sessionKey.trim() : DEFAULTS.sessionKey,
      });
    });
  });
}

export function saveSettings(settings: Settings): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY]: settings }, () => resolve());
  });
}
