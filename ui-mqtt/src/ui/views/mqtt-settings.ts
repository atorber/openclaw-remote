/**
 * MQTT connection settings view — shown before the main app when MQTT is not connected.
 * Left: gateway management list (generate ID, add gateway, list with connect/edit/delete).
 * Right: config panel for selected gateway.
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

export type GatewayProfile = {
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

export function loadGatewayList(): GatewayProfile[] {
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
  const list = loadGatewayList();
  const idx = list.findIndex((p) => p.gatewayId === settings.gatewayId);
  const profile: GatewayProfile = {
    gatewayId: settings.gatewayId,
    secretKey: settings.secretKey,
    brokerUrl: settings.brokerUrl,
    remark: settings.remark,
    lastUsed: Date.now(),
  };
  if (idx >= 0) {
    list.splice(idx, 1);
  }
  list.unshift(profile);
  localStorage.setItem(MQTT_HISTORY_KEY, JSON.stringify(list));
}

export function addGatewayToList(profile: Omit<GatewayProfile, "lastUsed">): void {
  const list = loadGatewayList();
  const existing = list.findIndex((p) => p.gatewayId === profile.gatewayId);
  const entry: GatewayProfile = {
    ...profile,
    brokerUrl: profile.brokerUrl || DEFAULT_BROKER_URL,
    lastUsed: Date.now(),
  };
  if (existing >= 0) {
    list.splice(existing, 1);
  }
  list.unshift(entry);
  localStorage.setItem(MQTT_HISTORY_KEY, JSON.stringify(list));
}

export function updateGatewayInList(
  gatewayId: string,
  updates: Partial<Pick<GatewayProfile, "remark" | "brokerUrl">>,
): void {
  const list = loadGatewayList();
  const idx = list.findIndex((p) => p.gatewayId === gatewayId);
  if (idx < 0) return;
  list[idx] = { ...list[idx], ...updates };
  localStorage.setItem(MQTT_HISTORY_KEY, JSON.stringify(list));
}

export function deleteGatewayFromList(gatewayId: string): void {
  const list = loadGatewayList().filter((p) => p.gatewayId !== gatewayId);
  localStorage.setItem(MQTT_HISTORY_KEY, JSON.stringify(list));
}

export type MqttDrawerMode = "view" | "edit" | "add" | null;

export type MqttSettingsCallbacks = {
  onConnect: (settings: MqttSettings) => void;
  onCancel: () => void;
  onFieldChange: (field: keyof MqttSettings, value: string) => void;
  onGenerate: () => void;
  onGatewayListChange: () => void;
  onConnectGateway: (profile: GatewayProfile) => void;
  onAddGateway: (profile: Omit<GatewayProfile, "lastUsed">) => void;
  onEditGateway: (gatewayId: string, updates: Partial<Pick<GatewayProfile, "remark">>) => void;
  onDeleteGateway: (gatewayId: string) => void;
  onOpenDrawerView?: (gatewayId: string) => void;
  onOpenDrawerEdit?: (gatewayId: string, remark: string) => void;
  onOpenDrawerAdd?: () => void;
  onCloseDrawer?: () => void;
  onDrawerEditRemarkChange?: (remark: string) => void;
  onSaveDrawerEdit?: () => void;
  onAddGatewayFormChange?: (form: {
    name: string;
    gatewayId: string;
    secretKey: string;
  }) => void;
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

function profileToSettings(p: GatewayProfile): MqttSettings {
  return {
    brokerUrl: p.brokerUrl || DEFAULT_BROKER_URL,
    gatewayId: p.gatewayId,
    secretKey: p.secretKey,
    remark: p.remark,
  };
}

function renderConfigPanel(
  gwId: string,
  sk: string,
  t: (key: string) => string,
  copyToClipboardFn: (text: string, btn: HTMLButtonElement) => void,
): TemplateResult {
  const configJson = JSON.stringify(
    {
      gateway: {
        controlUi: { allowInsecureAuth: true },
      },
      plugins: {
        entries: {
          "openclaw-mqtt-bridge": {
            enabled: true,
            config: { enabled: true, mqtt: { gatewayId: gwId, secretKey: sk } },
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
    <div class="mqtt-config-section">
      <div class="mqtt-config-header">
        <label>${t("mqtt.configCliTitle")}</label>
      </div>
      <div class="mqtt-cli-item">
        <pre class="mqtt-config-code mqtt-config-code--cli"><code>$ ${cliCmd1}</code></pre>
        <button class="mqtt-copy-icon-btn" title="${t("mqtt.copy")}" @click=${(e: MouseEvent) =>
          copyToClipboardFn(cliCmd1, e.currentTarget as HTMLButtonElement)}>${unsafeHTML(ICON_COPY)}</button>
      </div>
      <div class="mqtt-cli-item">
        <pre class="mqtt-config-code mqtt-config-code--cli"><code>$ ${cliCmd2}</code></pre>
        <button class="mqtt-copy-icon-btn" title="${t("mqtt.copy")}" @click=${(e: MouseEvent) =>
          copyToClipboardFn(cliCmd2, e.currentTarget as HTMLButtonElement)}>${unsafeHTML(ICON_COPY)}</button>
      </div>
    </div>
    <div class="mqtt-config-section">
      <div class="mqtt-config-header">
        <label>${t("mqtt.configJsonTitle")}</label>
        <button class="mqtt-copy-icon-btn" title="${t("mqtt.copy")}" @click=${(e: MouseEvent) =>
          copyToClipboardFn(configJson, e.currentTarget as HTMLButtonElement)}>${unsafeHTML(ICON_COPY)}</button>
      </div>
      <p class="mqtt-config-desc">${t("mqtt.configDesc")}</p>
      <pre class="mqtt-config-code"><code>${configJson}</code></pre>
    </div>
  `;
}

export function renderMqttSettings(
  settings: MqttSettings,
  callbacks: MqttSettingsCallbacks,
  error: string | null,
  connecting: boolean,
  drawerMode: MqttDrawerMode,
  drawerGatewayId: string | null,
  drawerEditRemark: string,
  addGatewayForm: { name: string; gatewayId: string; secretKey: string } | null,
): TemplateResult {
  const t = i18n.t.bind(i18n);
  const list = loadGatewayList();
  const viewProfile =
    drawerMode === "view" && drawerGatewayId
      ? list.find((p) => p.gatewayId === drawerGatewayId) ?? null
      : null;
  const editProfile =
    drawerMode === "edit" && drawerGatewayId
      ? list.find((p) => p.gatewayId === drawerGatewayId) ?? null
      : null;

  const drawerTitle =
    drawerMode === "view"
      ? t("mqtt.viewConfig")
      : drawerMode === "edit"
        ? t("mqtt.editGateway")
        : drawerMode === "add"
          ? t("mqtt.addGatewayTitle")
          : "";

  const drawerBody =
    drawerMode === "view" && viewProfile
      ? renderConfigPanel(
          viewProfile.gatewayId,
          viewProfile.secretKey,
          t,
          copyToClipboard,
        )
      : drawerMode === "edit" && editProfile
        ? html`
            <div class="mqtt-drawer-form">
              <div class="mqtt-settings-field">
                <label>${t("mqtt.name")}</label>
                <input
                  type="text"
                  .value=${drawerEditRemark}
                  placeholder="${t("mqtt.remarkPlaceholder")}"
                  @input=${(e: InputEvent) =>
                    callbacks.onDrawerEditRemarkChange?.((e.target as HTMLInputElement).value)}
                />
              </div>
              <div class="mqtt-drawer-actions">
                <button
                  class="mqtt-settings-connect-btn"
                  @click=${() => {
                    updateGatewayInList(editProfile.gatewayId, { remark: drawerEditRemark.trim() });
                    callbacks.onEditGateway(editProfile.gatewayId, { remark: drawerEditRemark.trim() });
                    callbacks.onGatewayListChange();
                    callbacks.onCloseDrawer?.();
                  }}
                >
                  ${t("mqtt.save")}
                </button>
                <button class="mqtt-settings-cancel-btn" @click=${() => callbacks.onCloseDrawer?.()}>
                  ${t("mqtt.cancel")}
                </button>
              </div>
            </div>
          `
        : drawerMode === "add" && addGatewayForm
          ? html`
              <div class="mqtt-drawer-form">
                <div class="mqtt-settings-field">
                  <label>${t("mqtt.name")}</label>
                  <input
                    type="text"
                    .value=${addGatewayForm.name}
                    placeholder="${t("mqtt.remarkPlaceholder")}"
                    @input=${(e: InputEvent) =>
                      callbacks.onAddGatewayFormChange?.({
                        ...addGatewayForm,
                        name: (e.target as HTMLInputElement).value,
                      })}
                  />
                </div>
                <div class="mqtt-settings-field">
                  <label>${t("mqtt.gatewayId")}</label>
                  <input
                    type="text"
                    .value=${addGatewayForm.gatewayId}
                    placeholder="gw-xxxxxxxx"
                    @input=${(e: InputEvent) =>
                      callbacks.onAddGatewayFormChange?.({
                        ...addGatewayForm,
                        gatewayId: (e.target as HTMLInputElement).value,
                      })}
                  />
                </div>
                <div class="mqtt-settings-field">
                  <label>${t("mqtt.secretKey")}</label>
                  <input
                    type="password"
                    .value=${addGatewayForm.secretKey}
                    placeholder="Base64 encoded 256-bit key"
                    autocomplete="off"
                    @input=${(e: InputEvent) =>
                      callbacks.onAddGatewayFormChange?.({
                        ...addGatewayForm,
                        secretKey: (e.target as HTMLInputElement).value,
                      })}
                  />
                </div>
                <div class="mqtt-drawer-actions">
                  <button
                    class="mqtt-settings-connect-btn"
                    ?disabled=${!addGatewayForm.gatewayId.trim() || !addGatewayForm.secretKey.trim()}
                    @click=${() => {
                      addGatewayToList({
                        remark: addGatewayForm.name.trim(),
                        gatewayId: addGatewayForm.gatewayId.trim(),
                        secretKey: addGatewayForm.secretKey,
                        brokerUrl: DEFAULT_BROKER_URL,
                      });
                      callbacks.onGatewayListChange();
                      callbacks.onCloseDrawer?.();
                    }}
                  >
                    ${t("mqtt.confirmAdd")}
                  </button>
                  <button class="mqtt-settings-cancel-btn" @click=${() => callbacks.onCloseDrawer?.()}>
                    ${t("mqtt.cancel")}
                  </button>
                </div>
              </div>
            `
          : null;

  return html`
    <div class="mqtt-settings">
      <div class="mqtt-settings-layout">
        <div class="mqtt-settings-card">
          <h2 class="mqtt-settings-title">
            <img src="${openclawIcon}" alt="" class="mqtt-settings-icon" />${t("mqtt.title")}
            <span class="mqtt-settings-version">v${__APP_VERSION__}</span>
          </h2>
          <p class="mqtt-settings-desc">${t("mqtt.description")}</p>

          ${error ? html`<div class="mqtt-settings-error">${error}</div>` : ""}

          <div class="mqtt-list-actions">
            <button
              class="mqtt-settings-generate-btn"
              ?disabled=${connecting}
              @click=${() => {
                const creds = generateCredentials();
                addGatewayToList({
                  gatewayId: creds.gatewayId,
                  secretKey: creds.secretKey,
                  brokerUrl: DEFAULT_BROKER_URL,
                  remark: "",
                });
                callbacks.onGatewayListChange();
              }}
            >
              ${t("mqtt.generate")}
            </button>
            <button
              class="mqtt-settings-add-gateway-btn"
              ?disabled=${connecting}
              @click=${() => callbacks.onOpenDrawerAdd?.()}
            >
              ${t("mqtt.addGateway")}
            </button>
          </div>

          <div class="mqtt-gateway-table-wrap">
            <table class="mqtt-gateway-table">
              <thead>
                <tr>
                  <th>${t("mqtt.name")}</th>
                  <th>${t("mqtt.gatewayId")}</th>
                  <th>${t("mqtt.secretKey")}</th>
                  <th class="mqtt-gateway-table-actions">${t("mqtt.actions")}</th>
                </tr>
              </thead>
              <tbody>
                ${list.length === 0
                  ? html`
                      <tr>
                        <td colspan="4" class="mqtt-gateway-table-empty">${t("mqtt.noGateways")}</td>
                      </tr>
                    `
                  : list.map(
                      (p) => html`
                        <tr>
                          <td><span class="mqtt-list-name">${p.remark || p.gatewayId}</span></td>
                          <td><code class="mqtt-list-gw-id">${p.gatewayId}</code></td>
                          <td><code class="mqtt-list-secret">${p.secretKey ? "••••••••" : ""}</code></td>
                          <td class="mqtt-gateway-table-actions">
                            <button
                              class="mqtt-list-btn mqtt-list-btn--view"
                              title="${t("mqtt.view")}"
                              @click=${() => callbacks.onOpenDrawerView?.(p.gatewayId)}
                            >
                              ${t("mqtt.view")}
                            </button>
                            <button
                              class="mqtt-list-btn mqtt-list-btn--connect"
                              ?disabled=${connecting}
                              title="${t("mqtt.connect")}"
                              @click=${() => {
                                saveMqttSettings(profileToSettings(p));
                                callbacks.onConnect(profileToSettings(p));
                              }}
                            >
                              ${t("mqtt.connect")}
                            </button>
                            <button
                              class="mqtt-list-btn mqtt-list-btn--edit"
                              title="${t("mqtt.edit")}"
                              @click=${() => callbacks.onOpenDrawerEdit?.(p.gatewayId, p.remark)}
                            >
                              ${t("mqtt.edit")}
                            </button>
                            <button
                              class="mqtt-list-btn mqtt-list-btn--delete"
                              title="${t("mqtt.delete")}"
                              @click=${() => {
                                deleteGatewayFromList(p.gatewayId);
                                callbacks.onDeleteGateway(p.gatewayId);
                                callbacks.onGatewayListChange();
                              }}
                            >
                              ${t("mqtt.delete")}
                            </button>
                          </td>
                        </tr>
                      `,
                    )}
              </tbody>
            </table>
          </div>

          <p class="mqtt-settings-hint">${t("mqtt.hint")}</p>
        </div>
      </div>

      ${drawerMode !== null
        ? html`
            <div
              class="mqtt-drawer-backdrop"
              @click=${() => callbacks.onCloseDrawer?.()}
              aria-hidden="true"
            ></div>
            <div class="mqtt-drawer mqtt-drawer--open" role="dialog" aria-label="${drawerTitle}">
              <div class="mqtt-drawer-header">
                <h3 class="mqtt-drawer-title">${drawerTitle}</h3>
                <button
                  type="button"
                  class="mqtt-drawer-close"
                  title="${t("mqtt.closeDrawer")}"
                  @click=${() => callbacks.onCloseDrawer?.()}
                >
                  ×
                </button>
              </div>
              <div class="mqtt-drawer-body">${drawerBody}</div>
            </div>
          `
        : ""}
    </div>
  `;
}
