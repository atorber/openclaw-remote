/**
 * Extension settings from VS Code configuration and globalState.
 */

import type { WorkspaceConfiguration } from "vscode";

export interface Settings {
  brokerUrl: string;
  gatewayId: string;
  secretKey: string;
  sessionKey: string;
}

const DEFAULT_BROKER = "wss://broker.emqx.io:8084/mqtt";
const DEFAULT_SESSION = "agent:default:main";

export function getSettings(config: WorkspaceConfiguration): Settings {
  return {
    brokerUrl: config.get<string>("brokerUrl")?.trim() || DEFAULT_BROKER,
    gatewayId: config.get<string>("gatewayId")?.trim() || "",
    secretKey: config.get<string>("secretKey") || "",
    sessionKey: config.get<string>("sessionKey")?.trim() || DEFAULT_SESSION,
  };
}

export function updateSettings(
  config: WorkspaceConfiguration,
  key: "brokerUrl" | "gatewayId" | "secretKey" | "sessionKey",
  value: string,
): void {
  config.update(key, value, true);
}
