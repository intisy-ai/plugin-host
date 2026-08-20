import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CommandsCapability, PluginManifest, PluginRuntime, SettingsCapability } from "@intisy-ai/api";
import { callCapability, DEFAULT_CALL_TIMEOUT_MS, ledgerRows, startPlugins } from "./plugin-host.js";

const FIXTURES = join(import.meta.dirname, "__fixtures__", "plugins");

function deployedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "loader-e2e-"));
  const pluginDir = join(home, "plugin");
  mkdirSync(pluginDir, { recursive: true });
  cpSync(FIXTURES, pluginDir, { recursive: true });
  return pluginDir;
}

function runtimeFor(_manifest: PluginManifest): PluginRuntime {
  return {
    config: { all: () => ({}), get: () => undefined, set: async () => {} },
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    paths: { home: "/home", repos: "/home/repos", plugin: "/home/plugin", cache: "/home/cache", config: "/home/config" },
    events: { publish: () => {}, subscribe: () => () => {} },
  };
}

describe("loading a manifest-declared plugin end to end", () => {
  it("activates providers before consumers, from real sidecars and real imports", async () => {
    const loaded = await startPlugins({ app: "test", pluginDir: deployedHome(), runtimeFor });

    expect(loaded.started).toEqual(["demo-store", "demo-reader"]);
    expect(loaded.host.service("demo-store:items")).toBeDefined();
  });

  it("hands the host every implementation, attributed to its plugin", async () => {
    const loaded = await startPlugins({ app: "test", pluginDir: deployedHome(), runtimeFor });

    const [settings] = loaded.host.capability<"settings">("settings");
    expect(settings.pluginId).toBe("demo-store");
    expect((settings.implementation as SettingsCapability).schema()).toEqual({
      fields: [{ key: "limit", type: "number", label: "Limit" }],
    });

    const [commands] = loaded.host.capability<"commands">("commands");
    expect(commands.pluginId).toBe("demo-reader");
    expect(await (commands.implementation as CommandsCapability).commands()).toEqual([
      { name: "demo", description: "demo over 2 items" },
    ]);
  });

  it("quarantines only the plugin that threw", async () => {
    const loaded = await startPlugins({ app: "test", pluginDir: deployedHome(), runtimeFor });

    expect(loaded.quarantined.map((error) => error.pluginId)).toEqual(["demo-broken"]);
    expect(loaded.quarantined[0].detail).toContain("cannot reach its data directory");
    expect(loaded.host.capability("screens")).toEqual([]);
    expect(loaded.started).toHaveLength(2);
  });

  it("records every relationship in the ledger", async () => {
    const loaded = await startPlugins({ app: "test", pluginDir: deployedHome(), runtimeFor });
    const rows = Object.fromEntries(ledgerRows(loaded).map((row) => [row.pluginId, row]));

    expect(rows["demo-store"].status).toBe("active");
    expect(rows["demo-store"].services.provides).toEqual(["demo-store:items"]);
    expect(rows["demo-store"].topics).toEqual(["config.changed"]);
    expect(rows["demo-store"].permissions).toEqual(["network"]);
    expect(rows["demo-reader"].services.consumes).toEqual(["demo-store:items"]);
    expect(rows["demo-reader"].unresolved).toEqual([]);
    expect(rows["demo-broken"].status).toBe("broken");
  });

  it("runs a declared action through the bounded call path", async () => {
    const loaded = await startPlugins({ app: "test", pluginDir: deployedHome(), runtimeFor });
    const [settings] = loaded.host.capability<"settings">("settings");
    const result = await callCapability(settings.pluginId, "settings.run", DEFAULT_CALL_TIMEOUT_MS,
      () => (settings.implementation as SettingsCapability).run("refresh"));

    expect(result).toEqual({ ok: true, value: { ok: true, message: "refresh" } });
  });

  it("stops every started plugin and leaves no capability behind", async () => {
    const loaded = await startPlugins({ app: "test", pluginDir: deployedHome(), runtimeFor });
    await loaded.stop();

    expect(loaded.host.capability("settings")).toEqual([]);
    expect(loaded.host.capability("commands")).toEqual([]);
    expect(loaded.host.service("demo-store:items")).toBeUndefined();
  });
});
