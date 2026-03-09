/**
 * MQTT connection settings view — shown before the main app when MQTT is not connected.
 * Allows users to configure broker URL, gateway ID, and secret key.
 * Supports generating new gateway ID + secret key pairs.
 * Supports saving and selecting from historical gateway profiles.
 */

import openclawIcon from "/openclaw-icon.png?url";
import { html, type TemplateResult } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { i18n } from "../../i18n/index.ts";
import { generateGatewayId, generateSecretKey } from "../mqtt-crypto.ts";

declare const __APP_VERSION__: string;

const MQTT_SETTINGS_KEY = "openclaw.mqtt.settings.v1";
const MQTT_HISTORY_KEY = "openclaw.mqtt.history.v1";

export type MqttSettings = {
  brokerUrl: string;
  gatewayId: string;
  secretKey: string;
  remark: string;
};

type GatewayProfile = {
  gatewayId: string;
  secretKey: string;
  brokerUrl: string;
  remark: string;
  lastUsed: number;
};

const DEFAULT_BROKER_URL = "wss://broker.emqx.io:8084/mqtt";

export function loadMqttSettings(): MqttSettings {
  const defaults: MqttSettings = {
    brokerUrl: DEFAULT_BROKER_URL,
    gatewayId: "",
    secretKey: "",
    remark: "",
  };
  try {
    const raw = localStorage.getItem(MQTT_SETTINGS_KEY);
    if (!raw) {
      return defaults;
    }
    const parsed = JSON.parse(raw) as Partial<MqttSettings>;
    return {
      brokerUrl:
        typeof parsed.brokerUrl === "string" && parsed.brokerUrl.trim()
          ? parsed.brokerUrl.trim()
          : defaults.brokerUrl,
      gatewayId:
        typeof parsed.gatewayId === "string" ? parsed.gatewayId.trim() : defaults.gatewayId,
      secretKey: typeof parsed.secretKey === "string" ? parsed.secretKey : defaults.secretKey,
      remark: typeof parsed.remark === "string" ? parsed.remark : defaults.remark,
    };
  } catch {
    return defaults;
  }
}

export function saveMqttSettings(settings: MqttSettings): void {
  localStorage.setItem(MQTT_SETTINGS_KEY, JSON.stringify(settings));
  if (settings.gatewayId.trim()) {
    saveToHistory(settings);
  }
}

function loadHistory(): GatewayProfile[] {
  try {
    const raw = localStorage.getItem(MQTT_HISTORY_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (p: unknown): p is GatewayProfile =>
        typeof p === "object" &&
        p !== null &&
        typeof (p as GatewayProfile).gatewayId === "string" &&
        typeof (p as GatewayProfile).secretKey === "string",
    );
  } catch {
    return [];
  }
}

function saveToHistory(settings: MqttSettings): void {
  const history = loadHistory();
  const idx = history.findIndex((p) => p.gatewayId === settings.gatewayId);
  const profile: GatewayProfile = {
    gatewayId: settings.gatewayId,
    secretKey: settings.secretKey,
    brokerUrl: settings.brokerUrl,
    remark: settings.remark,
    lastUsed: Date.now(),
  };
  if (idx >= 0) {
    history.splice(idx, 1);
  }
  history.unshift(profile);
  localStorage.setItem(MQTT_HISTORY_KEY, JSON.stringify(history));
}

function deleteFromHistory(gatewayId: string): void {
  const history = loadHistory().filter((p) => p.gatewayId !== gatewayId);
  localStorage.setItem(MQTT_HISTORY_KEY, JSON.stringify(history));
}

export type MqttSettingsCallbacks = {
  onConnect: (settings: MqttSettings) => void;
  onCancel: () => void;
  onFieldChange: (field: keyof MqttSettings, value: string) => void;
  onGenerate: () => void;
};

/** Generate a new gateway ID + secret key pair. */
export function generateCredentials(): { gatewayId: string; secretKey: string } {
  return {
    gatewayId: generateGatewayId(),
    secretKey: generateSecretKey(),
  };
}

const ICON_COPY = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const ICON_CHECK = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

function copyToClipboard(text: string, buttonEl: HTMLButtonElement): void {
  void navigator.clipboard.writeText(text).then(() => {
    const original = buttonEl.innerHTML;
    buttonEl.innerHTML = ICON_CHECK;
    buttonEl.classList.add("mqtt-copy-btn--copied");
    setTimeout(() => {
      buttonEl.innerHTML = original;
      buttonEl.classList.remove("mqtt-copy-btn--copied");
    }, 1500);
  });
}

export function renderMqttSettings(
  settings: MqttSettings,
  callbacks: MqttSettingsCallbacks,
  error: string | null,
  connecting: boolean,
): TemplateResult {
  const t = i18n.t.bind(i18n);
  const canConnect = settings.gatewayId.trim() && settings.secretKey.trim();
  const history = loadHistory();

  const gwId = settings.gatewayId || "<your-gateway-id>";
  const sk = settings.secretKey || "<your-secret-key>";

  const configJson = JSON.stringify(
    {
      gateway: {
        controlUi: {
          allowInsecureAuth: true,
        },
      },
      plugins: {
        entries: {
          "openclaw-mqtt-bridge": {
            enabled: true,
            config: {
              enabled: true,
              mqtt: {
                gatewayId: gwId,
                secretKey: sk,
              },
            },
          },
        },
      },
    },
    null,
    2,
  );

  const cliCmd1 = `openclaw config set "gateway.controlUi.allowInsecureAuth" true`;
  const cliCmd2 = `openclaw config set "plugins.entries.openclaw-mqtt-bridge" '{"enabled":true,"config":{"enabled":true,"mqtt":{"gatewayId":"${gwId}","secretKey":"${sk}"}}}'`;

  return html`
    <div class="mqtt-settings">
      <div class="mqtt-settings-layout">
        <div class="mqtt-settings-card">
          <h2 class="mqtt-settings-title"><img src="${openclawIcon}" alt="" class="mqtt-settings-icon" />${t("mqtt.title")} <span class="mqtt-settings-version">v${__APP_VERSION__}</span></h2>
          <p class="mqtt-settings-desc">${t("mqtt.description")}</p>

          ${error ? html`<div class="mqtt-settings-error">${error}</div>` : ""}

          ${
            history.length > 0
              ? html`
              <div class="mqtt-settings-field">
                <label>${t("mqtt.history")}</label>
                <div class="mqtt-dropdown" @focusout=${(e: FocusEvent) => {
                  const dropdown = e.currentTarget as HTMLElement;
                  requestAnimationFrame(() => {
                    if (!dropdown.contains(document.activeElement)) {
                      dropdown.classList.remove("mqtt-dropdown--open");
                    }
                  });
                }}>
                  <button
                    class="mqtt-dropdown-trigger"
                    @click=${(e: MouseEvent) => {
                      const dropdown = (e.currentTarget as HTMLElement).parentElement!;
                      dropdown.classList.toggle("mqtt-dropdown--open");
                    }}
                  >
                    <span class="mqtt-dropdown-value">${
                      settings.gatewayId && history.some((h) => h.gatewayId === settings.gatewayId)
                        ? history.find((h) => h.gatewayId === settings.gatewayId)?.remark
                          ? `${history.find((h) => h.gatewayId === settings.gatewayId)!.remark} (${settings.gatewayId})`
                          : settings.gatewayId
                        : t("mqtt.historyPlaceholder")
                    }</span>
                    <span class="mqtt-dropdown-arrow">▾</span>
                  </button>
                  <div class="mqtt-dropdown-menu">
                    ${history.map(
                      (p) => html`
                        <div class="mqtt-dropdown-item ${p.gatewayId === settings.gatewayId ? "mqtt-dropdown-item--active" : ""}">
                          <button
                            class="mqtt-dropdown-item-label"
                            @click=${(e: MouseEvent) => {
                              callbacks.onFieldChange("gatewayId", p.gatewayId);
                              callbacks.onFieldChange("secretKey", p.secretKey);
                              callbacks.onFieldChange(
                                "brokerUrl",
                                p.brokerUrl || DEFAULT_BROKER_URL,
                              );
                              callbacks.onFieldChange("remark", p.remark || "");
                              (e.currentTarget as HTMLElement)
                                .closest(".mqtt-dropdown")!
                                .classList.remove("mqtt-dropdown--open");
                            }}
                          >${p.remark ? `${p.remark} (${p.gatewayId})` : p.gatewayId}</button>
                          <button
                            class="mqtt-dropdown-item-delete"
                            title="${t("mqtt.deleteHistory")}"
                            @click=${(e: MouseEvent) => {
                              e.stopPropagation();
                              deleteFromHistory(p.gatewayId);
                              (e.currentTarget as HTMLElement)
                                .closest(".mqtt-dropdown-item")!
                                .remove();
                              const menu = (e.currentTarget as HTMLElement).closest(
                                ".mqtt-dropdown-menu",
                              )!;
                              if (!menu.querySelector(".mqtt-dropdown-item")) {
                                menu
                                  .closest(".mqtt-dropdown")!
                                  .classList.remove("mqtt-dropdown--open");
                              }
                            }}
                          >✕</button>
                        </div>
                      `,
                    )}
                  </div>
                </div>
              </div>
            `
              : ""
          }

          <div class="mqtt-settings-field">
            <label>${t("mqtt.gatewayId")}</label>
              <input
                type="text"
                .value=${settings.gatewayId}
                placeholder="gw-xxxxxxxx"
                @input=${(e: InputEvent) =>
                  callbacks.onFieldChange("gatewayId", (e.target as HTMLInputElement).value)}
              />
          </div>

          <div class="mqtt-settings-field">
            <label>${t("mqtt.secretKey")}</label>
            <div class="mqtt-settings-input-row">
              <input
                type="password"
                .value=${settings.secretKey}
                placeholder="Base64 encoded 256-bit key"
                autocomplete="off"
                @input=${(e: InputEvent) =>
                  callbacks.onFieldChange("secretKey", (e.target as HTMLInputElement).value)}
              />
              <button
                class="mqtt-settings-copy-btn"
                title="Show/Hide"
                @click=${(e: MouseEvent) => {
                  const btn = e.currentTarget as HTMLButtonElement;
                  const input = btn.parentElement?.querySelector("input") as HTMLInputElement;
                  if (input) {
                    const isPassword = input.type === "password";
                    input.type = isPassword ? "text" : "password";
                    btn.textContent = isPassword ? "🙈" : "👁";
                  }
                }}
              >👁</button>
            </div>
          </div>

          <div class="mqtt-settings-field">
            <label>${t("mqtt.remark")}</label>
              <input
                type="text"
                .value=${settings.remark}
                placeholder="${t("mqtt.remarkPlaceholder")}"
                @input=${(e: InputEvent) =>
                  callbacks.onFieldChange("remark", (e.target as HTMLInputElement).value)}
              />
          </div>

          <div class="mqtt-settings-actions">
            <button
              class="mqtt-settings-generate-btn"
              ?disabled=${connecting}
              @click=${() => callbacks.onGenerate()}
            >${t("mqtt.generate")}</button>

            ${
              connecting
                ? html`
                <button
                  class="mqtt-settings-cancel-btn"
                  @click=${() => callbacks.onCancel()}
                >${t("mqtt.cancel")}</button>
                <button class="mqtt-settings-connect-btn" disabled
                >${t("mqtt.connecting")}</button>
              `
                : html`
                <button
                  class="mqtt-settings-connect-btn"
                  ?disabled=${!canConnect}
                  @click=${() => {
                    if (canConnect) {
                      saveMqttSettings(settings);
                      callbacks.onConnect(settings);
                    }
                  }}
                >${t("mqtt.connect")}</button>
              `
            }
          </div>

          <p class="mqtt-settings-hint">${t("mqtt.hint")}</p>
        </div>

        <div class="mqtt-config-panel">
          <div class="mqtt-config-section">
            <div class="mqtt-config-header">
              <label>${t("mqtt.configCliTitle")}</label>
            </div>
            <div class="mqtt-cli-item">
              <pre class="mqtt-config-code mqtt-config-code--cli"><code>$ ${cliCmd1}</code></pre>
              <button
                class="mqtt-copy-icon-btn"
                title="${t("mqtt.copy")}"
                @click=${(e: MouseEvent) =>
                  copyToClipboard(cliCmd1, e.currentTarget as HTMLButtonElement)}
              >${unsafeHTML(ICON_COPY)}</button>
            </div>
            <div class="mqtt-cli-item">
              <pre class="mqtt-config-code mqtt-config-code--cli"><code>$ ${cliCmd2}</code></pre>
              <button
                class="mqtt-copy-icon-btn"
                title="${t("mqtt.copy")}"
                @click=${(e: MouseEvent) =>
                  copyToClipboard(cliCmd2, e.currentTarget as HTMLButtonElement)}
              >${unsafeHTML(ICON_COPY)}</button>
            </div>
          </div>

          <div class="mqtt-config-section">
            <div class="mqtt-config-header">
              <label>${t("mqtt.configJsonTitle")}</label>
              <button
                class="mqtt-copy-icon-btn"
                title="${t("mqtt.copy")}"
                @click=${(e: MouseEvent) =>
                  copyToClipboard(configJson, e.currentTarget as HTMLButtonElement)}
              >${unsafeHTML(ICON_COPY)}</button>
            </div>
            <p class="mqtt-config-desc">${t("mqtt.configDesc")}</p>
            <pre class="mqtt-config-code"><code>${configJson}</code></pre>
          </div>
        </div>
      </div>
    </div>
  `;
}
