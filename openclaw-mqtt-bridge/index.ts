import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { MqttBridge } from "./src/bridge.js";
import { parseConfig } from "./src/config.js";

const plugin = {
  id: "openclaw-mqtt-bridge",
  name: "OpenClaw MQTT Bridge",
  description: "Bridge Gateway WS protocol to MQTT for remote UI access",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    let config;
    try {
      config = parseConfig(api.pluginConfig, api.config);
    } catch (err) {
      api.logger.error(String(err));
      return;
    }

    if (!config.enabled) {
      api.logger.info("openclaw-mqtt-bridge: disabled by config");
      return;
    }

    let bridge: MqttBridge | null = null;

    api.on("gateway_start", async (event) => {
      try {
        bridge = new MqttBridge(config, api.logger);
        await bridge.start(event.port);
        api.logger.info("openclaw-mqtt-bridge: started");
      } catch (err) {
        api.logger.error(`openclaw-mqtt-bridge: failed to start: ${String(err)}`);
        bridge = null;
      }
    });

    api.on("gateway_stop", async () => {
      try {
        await bridge?.stop();
      } catch (err) {
        api.logger.warn(`openclaw-mqtt-bridge: error during stop: ${String(err)}`);
      }
      bridge = null;
    });
  },
};

export default plugin;
