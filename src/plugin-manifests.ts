import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { assertManifest, isPluginError, PluginError } from "@intisy-ai/api";
import type { PluginManifest } from "@intisy-ai/api";

/** One plugin as it sits deployed in a home: its manifest sidecar and the bundle beside it. */
export interface DeployedPlugin {
  /** The validated manifest. */
  manifest: PluginManifest;
  /** Absolute path of the sidecar this was read from. */
  manifestPath: string;
  /** Absolute path of the deployed bundle, or null when the plugin declares no entry or none is deployed. */
  entryPath: string | null;
}

/** What one scan of a home's plugin directory found, and what it could not read. */
export interface ManifestScan {
  /** Every plugin whose manifest validated, ordered by id. */
  loaded: DeployedPlugin[];
  /** One error per sidecar that could not be read or did not validate. */
  failed: PluginError[];
}

function entryFor(pluginDir: string, manifest: PluginManifest): string | null {
  if (!manifest.entry) return null;
  const deployed = join(pluginDir, `${manifest.id}.js`);
  return existsSync(deployed) ? deployed : null;
}

/**
 * Reads every manifest sidecar deployed in a home.
 *
 * @remarks
 * Deploy writes the manifest beside the bundle, so identity and capability questions are answered
 * from disk without importing anything. One unreadable sidecar becomes one entry in `failed` and
 * never discards the rest of the home, because a host that hides every plugin behind one bad file
 * is a host nobody can diagnose.
 *
 * @param pluginDir - the home's plugin directory, normally `<home>/plugin`
 */
export function readDeployedManifests(pluginDir: string): ManifestScan {
  let loaded: DeployedPlugin[] = [];
  const failed: PluginError[] = [];

  let names: string[];
  try {
    names = readdirSync(pluginDir);
  } catch (error) {
    const err = error as any;
    if (err.code === "ENOENT") {
      return { loaded, failed };
    }
    failed.push(new PluginError(
      "plugin-dir",
      `Plugin directory ${pluginDir} is not accessible: ${String(error)}`,
      "ensure the directory exists and is readable"
    ));
    return { loaded, failed };
  }

  const pendingLoad: Array<{ manifestPath: string; filename: string; manifest: PluginManifest }> = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    // Deploy writes this marker for the directory itself, so Node treats every bundle as ESM.
    // A plugin id of "package" could never deploy its sidecar here: writing it would overwrite
    // the marker and change how Node parses the whole directory, so the marker owns the name.
    if (name === "package.json") continue;
    const manifestPath = join(pluginDir, name);
    const filename = basename(name, ".json");
    try {
      const manifest = assertManifest(JSON.parse(readFileSync(manifestPath, "utf-8")));
      pendingLoad.push({ manifestPath, filename, manifest });
    } catch (error) {
      let detail: string;
      let fix: string;
      if (isPluginError(error)) {
        const apiError = error as PluginError;
        detail = `${manifestPath}: ${apiError.detail}`;
        fix = apiError.fix;
      } else {
        detail = `${manifestPath} is not readable as JSON: ${String(error)}`;
        fix = "redeploy the plugin so its plugin.json sidecar is written again";
      }
      failed.push(new PluginError(filename, detail, fix));
    }
  }

  for (const item of pendingLoad) {
    if (item.manifest.id !== item.filename) {
      failed.push(new PluginError(
        item.filename,
        `${item.manifestPath}: plugin id "${item.manifest.id}" does not match filename "${item.filename}.json"`,
        "redeploy the plugin so the sidecar and bundle filenames match the declared id"
      ));
      continue;
    }
    // manifest.id === filename is guaranteed; directory entries are unique; so id collisions are impossible.
    loaded.push({ manifest: item.manifest, manifestPath: item.manifestPath, entryPath: entryFor(pluginDir, item.manifest) });
  }

  loaded.sort((left, right) => {
    const leftId = left.manifest.id;
    const rightId = right.manifest.id;
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });

  return { loaded, failed };
}
