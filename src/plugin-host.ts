import { pathToFileURL } from "node:url";
import { CAPABILITY_IDS, WELL_KNOWN_SERVICES } from "@intisy-ai/api";
import { activationOrder, createPluginHost, isPluginError, pluginError } from "@intisy-ai/api/engine";
import type { HostSurface, PluginErrorShape } from "@intisy-ai/api/engine";
import type { Plugin, PluginContext, PluginHost, PluginManifest, PluginRuntime } from "@intisy-ai/api";
import { readDeployedManifests } from "./plugin-manifests.js";
import type { DeployedPlugin, ManifestScan } from "./plugin-manifests.js";

/** How long one plugin's `activate` may take before it is quarantined. */
export const DEFAULT_ACTIVATE_TIMEOUT_MS = 10000;

/**
 * How long one plugin's `deactivate` may take before the host stops waiting for it.
 *
 * @remarks
 * Its own budget rather than the activate one: a `deactivate` runs on shutdown, where the whole
 * home is waiting on the slowest plugin, while an `activate` runs on load with nothing yet to lose.
 */
export const DEFAULT_DEACTIVATE_TIMEOUT_MS = 5000;

/** What the host needs from whoever starts it. */
export interface PluginHostOptions {
  /** The app id plugins see on the host descriptor. */
  app: string;
  /** The home's plugin directory, normally `<home>/plugin`. */
  pluginDir: string;
  /** Surface ids this host renders. */
  surfaces?: string[];
  /** How long one `activate` may take. Defaults to {@link DEFAULT_ACTIVATE_TIMEOUT_MS}. */
  activateTimeoutMs?: number;
  /** How long one `deactivate` may take. Defaults to {@link DEFAULT_DEACTIVATE_TIMEOUT_MS}. */
  deactivateTimeoutMs?: number;
  /**
   * Builds the per-plugin runtime.
   *
   * @remarks
   * Injected rather than built here, because this library carries no core submodule: whoever
   * starts the host passes core's `createPluginRuntime`.
   */
  runtimeFor: (manifest: PluginManifest) => PluginRuntime;
  /** Reads the home. Defaults to {@link readDeployedManifests}, and is replaced in tests. */
  scan?: ManifestScan;
  /** Imports one entry module. Defaults to a dynamic import, and is replaced in tests. */
  importEntry?: (entryPath: string) => Promise<unknown>;
}

/**
 * The engine's host surface, re-typed so `capability` and `service` look up by the api's own
 * vocabulary.
 *
 * @remarks
 * The engine mints neither vocabulary, so its generated `capability` and `service` take a bare
 * string. This package owns `CapabilityMap` and `ServiceMap` through api's `PluginHost`, so both
 * typed overloads are picked from there rather than hand-copied, which would drift the day api
 * adds a third.
 */
export type PluginHostFacade = Omit<HostSurface, "capability" | "service"> & Pick<PluginHost, "capability" | "service">;

/** A running host: what started, what did not, and how to shut it down. */
export interface LoadedHost {
  /** The api package's host, which owns the capabilities, the services and the ledger. */
  host: PluginHostFacade;
  /** Plugin ids that activated cleanly, in activation order. */
  started: string[];
  /** One error per plugin that could not be loaded, each naming the plugin and the fix. */
  quarantined: PluginErrorShape[];
  /** Every plugin whose manifest validated, as the scan found it on disk. */
  deployed: DeployedPlugin[];
  /**
   * Deactivates every started plugin, newest first, each under its own deadline.
   *
   * @remarks
   * Calling it again waits on the shutdown already running rather than deactivating anything a
   * second time.
   */
  stop: () => Promise<void>;
}

function pluginFrom(candidate: unknown): Plugin | null {
  if (!candidate || typeof candidate !== "object") return null;
  const plugin = candidate as Partial<Plugin>;
  if (typeof plugin.activate !== "function" || typeof plugin.deactivate !== "function") return null;
  return plugin as Plugin;
}

/**
 * Reads a plugin out of an imported entry module.
 *
 * @remarks
 * The module namespace is read only when there is no default export, because a TeaVM-compiled
 * plugin can only ever export `activate` and `deactivate` by name: TeaVM emits named exports and
 * cannot emit an object as a default, so requiring one would reject a Java-authored plugin for a
 * reason unrelated to its correctness. A module that does export a default is judged on that
 * default alone, so a broken one is rejected rather than papered over by whatever the namespace
 * happens to expose.
 */
function asPlugin(module: unknown): Plugin | null {
  const namespace = module as { default?: unknown } | null;
  return namespace?.default === undefined ? pluginFrom(namespace) : pluginFrom(namespace.default);
}

function detailOf(error: unknown): string {
  if (isPluginError(error)) {
    const detail = (error as PluginErrorShape).detail;
    if (detail) return detail;
  }
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" && message ? message : String(error);
}

/**
 * Attributes a caught failure to the plugin the host was calling.
 *
 * @remarks
 * A caught {@link PluginErrorShape} carries whatever `pluginId` its thrower chose, and the thrower
 * may be another plugin's service. Its detail and fix are worth keeping, its attribution is not:
 * the quarantine belongs to the plugin whose call failed.
 */
function errorFor(pluginId: string, error: unknown, fix: string): PluginErrorShape {
  const carried = isPluginError(error) && (error as PluginErrorShape).fix ? (error as PluginErrorShape).fix : fix;
  return pluginError(pluginId, detailOf(error), carried);
}

/**
 * Quarantines a plugin before its context ever opened.
 *
 * @remarks
 * `recordDeclared` runs first so the ledger entry carries what the manifest actually declared
 * (capabilities, permissions) alongside the error, rather than a blank entry a reader would
 * mistake for "declared nothing". `markBroken` runs after, so its status and error survive:
 * `recordDeclared` resets status to `activating` and clears any error, and reversing the order
 * would silently undo the quarantine.
 */
function quarantine(host: HostSurface, quarantined: PluginErrorShape[], manifest: PluginManifest, error: PluginErrorShape): void {
  host.ledger.recordDeclared(manifest);
  host.markBroken(manifest.id, error);
  quarantined.push(error);
}

async function callWithDeadline<T>(
  pluginId: string,
  timeoutMs: number,
  detail: string,
  fix: string,
  work: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(pluginError(pluginId, detail, fix)), timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(work), expiry]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withTimeout(pluginId: string, timeoutMs: number, run: () => void | Promise<void>): Promise<void> {
  await callWithDeadline(
    pluginId,
    timeoutMs,
    `activate did not finish within ${timeoutMs}ms`,
    "return from activate promptly and do slow work in the background, or raise the host's activate timeout",
    async () => { await Promise.resolve(run()); },
  );
}

async function callDeactivate(pluginId: string, timeoutMs: number, plugin: Plugin): Promise<void> {
  await callWithDeadline(
    pluginId,
    timeoutMs,
    `deactivate did not finish within ${timeoutMs}ms`,
    "return from deactivate promptly and do slow work in the background, or raise the host's deactivate timeout",
    async () => { await Promise.resolve(plugin.deactivate()); },
  );
}

/**
 * Stops a plugin that is about to be quarantined.
 *
 * @remarks
 * `activate` ran, so the plugin's timers, watchers and child processes are live, and quarantine
 * drops it from the started list where `stop` would otherwise have reached it. A `deactivate` that
 * throws or hangs is swallowed: the quarantine that follows is already the answer to it.
 *
 * On the timeout path this is a trade rather than a clean stop. `activate` was abandoned, not
 * cancelled, so `deactivate` can run before the resources it means to release exist, throw into
 * the swallow, and then the abandoned `activate` finishes and starts the very thing that was meant
 * to be stopped. It is still worth calling: the plugin's context is fenced by then, so whatever
 * starts cannot register itself back into the host, and the common case (an `activate` that threw
 * after taking resources) is stopped properly.
 */
async function stopBeforeQuarantine(pluginId: string, timeoutMs: number, plugin: Plugin): Promise<void> {
  try {
    await callDeactivate(pluginId, timeoutMs, plugin);
  } catch {
    return;
  }
}

/**
 * Loads every plugin deployed in a home: manifests first, then dependency order, then one
 * `activate` at a time under its own timeout.
 *
 * @remarks
 * Nothing here branches on a plugin id, and nothing can. Every failure ends as a quarantine naming
 * the plugin and the fix, so one bad plugin costs its own capabilities and nothing else: a cycle
 * quarantines only its members, a throwing `activate` quarantines only its own plugin, and a
 * hanging one is cut loose at the timeout with the host still up. A plugin quarantined once
 * `activate` has been entered gets its `deactivate` called first, since it may have started work
 * the host would otherwise leave running with nothing holding it.
 */
export async function startPlugins(options: PluginHostOptions): Promise<LoadedHost> {
  const timeoutMs = options.activateTimeoutMs ?? DEFAULT_ACTIVATE_TIMEOUT_MS;
  const stopMs = options.deactivateTimeoutMs ?? DEFAULT_DEACTIVATE_TIMEOUT_MS;
  const importEntry = options.importEntry ?? (async (entryPath: string) => import(pathToFileURL(entryPath).href));
  const scan = options.scan ?? readDeployedManifests(options.pluginDir);

  const host = createPluginHost({
    app: options.app,
    surfaces: options.surfaces ?? [],
    vocabulary: [...CAPABILITY_IDS],
    wellKnownServices: [...WELL_KNOWN_SERVICES],
  });
  const quarantined: PluginErrorShape[] = [];
  const started: string[] = [];
  const plugins = new Map<string, Plugin>();
  const byId = new Map<string, DeployedPlugin>(scan.loaded.map((plugin) => [plugin.manifest.id, plugin]));

  for (const failure of scan.failed) {
    host.markBroken(failure.pluginId, failure);
    quarantined.push(failure);
  }

  const plan = activationOrder(scan.loaded.map((plugin) => plugin.manifest));
  for (const cycle of plan.cycles) {
    for (const pluginId of cycle) {
      const manifest = byId.get(pluginId)?.manifest;
      if (!manifest) continue;
      quarantine(host, quarantined, manifest, pluginError(
        pluginId,
        `is in a dependency cycle: ${cycle.join(" -> ")} -> ${cycle[0]}`,
        "break the cycle by removing one plugin's entry from services.consumes in its plugin.json",
      ));
    }
  }

  for (const pluginId of plan.order) {
    const deployed = byId.get(pluginId);
    if (!deployed) continue;
    const { manifest, entryPath } = deployed;

    const unsupported = host.supports(manifest);
    if (unsupported) {
      quarantine(host, quarantined, manifest, unsupported);
      continue;
    }

    if (!entryPath) {
      const error = pluginError(
        pluginId,
        manifest.entry ? "declares an entry but no bundle is deployed beside its manifest" : "declares no entry, so there is nothing to activate",
        manifest.entry ? "deploy the plugin again so its bundle lands beside the sidecar" : "add \"entry\": \"dist/index.js\" to plugin.json if this plugin has capabilities",
      );
      quarantine(host, quarantined, manifest, error);
      continue;
    }

    let plugin: Plugin | null;
    try {
      plugin = asPlugin(await importEntry(entryPath));
    } catch (error) {
      const failure = errorFor(pluginId, error, "rebuild the plugin: its deployed bundle could not be imported");
      quarantine(host, quarantined, manifest, failure);
      continue;
    }

    if (!plugin) {
      const error = pluginError(
        pluginId,
        "its entry module exports no plugin",
        "export default a class implementing Plugin, or definePlugin({ activate, deactivate }), or export activate and deactivate by name",
      );
      quarantine(host, quarantined, manifest, error);
      continue;
    }

    let context: PluginContext;
    try {
      context = host.contextFor(manifest, options.runtimeFor(manifest)) as unknown as PluginContext;
    } catch (error) {
      const failure = errorFor(pluginId, error, "fix the plugin's own configuration; its runtime could not be built");
      quarantine(host, quarantined, manifest, failure);
      continue;
    }

    try {
      await withTimeout(pluginId, timeoutMs, () => plugin.activate(context));
    } catch (error) {
      const failure = errorFor(pluginId, error, "fix the error activate threw, or disable the plugin");
      await stopBeforeQuarantine(pluginId, stopMs, plugin);
      host.markBroken(pluginId, failure);
      quarantined.push(failure);
      continue;
    }

    const mismatch = host.verifyActivation(manifest);
    if (mismatch) {
      await stopBeforeQuarantine(pluginId, stopMs, plugin);
      host.markBroken(pluginId, mismatch);
      quarantined.push(mismatch);
      continue;
    }

    plugins.set(pluginId, plugin);
    started.push(pluginId);
  }

  async function shutDown(): Promise<void> {
    for (const pluginId of [...started].reverse()) {
      const plugin = plugins.get(pluginId);
      if (!plugin) continue;
      try {
        await callDeactivate(pluginId, stopMs, plugin);
      } catch (error) {
        host.markBroken(pluginId, errorFor(pluginId, error, "fix the error deactivate threw; the plugin was stopped anyway"));
        continue;
      }
      host.release(pluginId);
    }
  }

  let shutdown: Promise<void> | null = null;
  return {
    host: host as unknown as PluginHostFacade,
    started,
    quarantined,
    deployed: scan.loaded,
    stop: async () => {
      shutdown ??= shutDown();
      await shutdown;
    },
  };
}

/** How long a capability read may take. */
export const DEFAULT_CALL_TIMEOUT_MS = 10000;

/** How long a capability action may take, since one may do real work such as a multi-file restore. */
export const DEFAULT_INVOKE_TIMEOUT_MS = 600000;

/** What one bounded capability call produced. */
export type CapabilityCall<T> = { ok: true; value: T } | { ok: false; error: PluginErrorShape };

/**
 * Calls into a plugin with a deadline.
 *
 * @remarks
 * Plugins run in this process, so a capability that hangs or throws would otherwise be the host's
 * problem. A failure here is NOT a quarantine: a slow screen read says nothing about the plugin's
 * services, and dropping its registrations over one call would take out far more than the surface
 * that failed. Every call always returns a result object, never throws.
 *
 * @param pluginId - the plugin being called
 * @param label - what was being called, for example `screens.read`, which appears in the error
 * @param timeoutMs - deadline in milliseconds
 * @param call - the async work to perform
 */
export async function callCapability<T>(
  pluginId: string,
  label: string,
  timeoutMs: number,
  call: () => Promise<T>,
): Promise<CapabilityCall<T>> {
  try {
    const value = await callWithDeadline(
      pluginId,
      timeoutMs,
      `${label} did not answer within ${timeoutMs}ms`,
      "make the call return promptly, or check whether the plugin is waiting on something that never arrives",
      call,
    );
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: errorFor(pluginId, error, `fix what ${label} threw, or disable the plugin`) };
  }
}

/** One plugin's whole relationship record, in the shape a surface renders. */
export interface PluginLedgerRow {
  /** The plugin this row describes. */
  pluginId: string;
  /** Where the plugin stands: activating, active, broken or stopped. */
  status: string;
  /** Capability ids its manifest declared. */
  capabilitiesDeclared: string[];
  /** Capability ids it actually provided. */
  capabilities: string[];
  /** What it offers other plugins and what it asked of them. */
  services: {
    /** Service ids it registered. */
    provides: string[];
    /** Service ids it asked for, whether or not anything answered. */
    consumes: string[];
  };
  /** Event topics it subscribed to. */
  topics: string[];
  /** Permissions its manifest declares. */
  permissions: string[];
  /** Service ids it consumed that nothing in this home provides. */
  unresolved: string[];
  /** Why it is broken, when it is. */
  error?: {
    /** What went wrong. */
    detail: string;
    /** How to fix it. */
    fix: string;
  };
}

/**
 * Renders the host's ledger as rows.
 *
 * @remarks
 * The ledger is kept as the relationships are made, because a relationship is only observable at
 * the moment it happens. `unresolved` asks the live registry for each consumed id instead, since
 * whether a consumed service is answered depends on what is registered right now and that changes
 * as plugins are enabled and disabled.
 */
export function ledgerRows(loaded: LoadedHost): PluginLedgerRow[] {
  const entries = loaded.host.ledger.entries();
  return entries.map((entry) => {
    const row: PluginLedgerRow = {
      pluginId: entry.pluginId,
      status: entry.status,
      capabilitiesDeclared: entry.capabilitiesDeclared,
      capabilities: entry.capabilitiesProvided,
      services: { provides: entry.servicesProvided, consumes: entry.servicesConsumed },
      topics: entry.topics,
      permissions: entry.permissions,
      unresolved: entry.servicesConsumed.filter((serviceId) => loaded.host.service(serviceId) === undefined),
    };
    if (entry.error) row.error = entry.error;
    return row;
  });
}
