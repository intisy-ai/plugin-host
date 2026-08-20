import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readDeployedManifests } from "./plugin-manifests.js";

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "loader-manifests-"));
  mkdirSync(join(dir, "plugin"), { recursive: true });
  return join(dir, "plugin");
}

function write(pluginDir: string, id: string, manifest: unknown, withEntry = true): void {
  writeFileSync(join(pluginDir, `${id}.json`), JSON.stringify(manifest), "utf-8");
  if (withEntry) writeFileSync(join(pluginDir, `${id}.js`), "export default {};", "utf-8");
}

describe("readDeployedManifests", () => {
  it("returns nothing for a home with no plugin directory", () => {
    const scan = readDeployedManifests(join(tmpdir(), "loader-manifests-absent", "plugin"));
    expect(scan).toEqual({ loaded: [], failed: [] });
  });

  it("loads a valid manifest and resolves its entry beside it", () => {
    const dir = home();
    write(dir, "demo", { id: "demo", api: 1, entry: "dist/index.js", capabilities: ["settings"] });
    const scan = readDeployedManifests(dir);
    expect(scan.failed).toEqual([]);
    expect(scan.loaded).toHaveLength(1);
    expect(scan.loaded[0].manifest.id).toBe("demo");
    expect(scan.loaded[0].entryPath).toBe(join(dir, "demo.js"));
  });

  it("resolves no entry for a manifest whose bundle is missing", () => {
    const dir = home();
    write(dir, "no-bundle", { id: "no-bundle", api: 1, entry: "dist/index.js", capabilities: ["settings"] }, false);
    expect(readDeployedManifests(dir).loaded[0].entryPath).toBeNull();
  });

  it("resolves no entry for a library manifest that declares none", () => {
    const dir = home();
    writeFileSync(join(dir, "lib.json"), JSON.stringify({ id: "lib", api: 1 }), "utf-8");
    const scan = readDeployedManifests(dir);
    expect(scan.loaded[0].entryPath).toBeNull();
    expect(scan.failed).toEqual([]);
  });

  it("reports an invalid manifest without discarding the valid ones", () => {
    const dir = home();
    write(dir, "good", { id: "good", api: 1, entry: "dist/index.js", capabilities: ["settings"] });
    const badPath = join(dir, "bad.json");
    writeFileSync(badPath, JSON.stringify({ api: 1 }), "utf-8");
    const scan = readDeployedManifests(dir);
    expect(scan.loaded.map((plugin) => plugin.manifest.id)).toEqual(["good"]);
    expect(scan.failed).toHaveLength(1);
    expect(scan.failed[0].detail).toContain("id");
    expect(scan.failed[0].detail).toContain(badPath);
  });

  it("reports unparseable JSON as a failure naming the file", () => {
    const dir = home();
    writeFileSync(join(dir, "broken.json"), "{not json", "utf-8");
    const scan = readDeployedManifests(dir);
    expect(scan.loaded).toEqual([]);
    expect(scan.failed).toHaveLength(1);
    expect(scan.failed[0].pluginId).toBe("broken");
    expect(scan.failed[0].fix).toContain("plugin.json");
  });

  it("ignores a file that is not a manifest", () => {
    const dir = home();
    write(dir, "demo", { id: "demo", api: 1, entry: "dist/index.js", capabilities: ["settings"] });
    writeFileSync(join(dir, "notes.txt"), "hello", "utf-8");
    const scan = readDeployedManifests(dir);
    expect(scan.loaded).toHaveLength(1);
    expect(scan.failed).toEqual([]);
  });

  it("ignores the deploy directory's own package.json marker", () => {
    const dir = home();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }), "utf-8");
    const scan = readDeployedManifests(dir);
    expect(scan.loaded).toEqual([]);
    expect(scan.failed).toEqual([]);
  });

  it("loads the real sidecar alongside the package.json marker with no failures", () => {
    const dir = home();
    write(dir, "demo", { id: "demo", api: 1, entry: "dist/index.js", capabilities: ["settings"] });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }), "utf-8");
    const scan = readDeployedManifests(dir);
    expect(scan.loaded.map((plugin) => plugin.manifest.id)).toEqual(["demo"]);
    expect(scan.failed).toEqual([]);
  });

  it("orders the result by id so a host activates deterministically", () => {
    const dir = home();
    write(dir, "zebra", { id: "zebra", api: 1, entry: "dist/index.js", capabilities: ["settings"] });
    write(dir, "alpha", { id: "alpha", api: 1, entry: "dist/index.js", capabilities: ["settings"] });
    expect(readDeployedManifests(dir).loaded.map((plugin) => plugin.manifest.id)).toEqual(["alpha", "zebra"]);
  });

  it("reports a non-directory plugin path as a failure", () => {
    const dir = home();
    write(dir, "demo", { id: "demo", api: 1, entry: "dist/index.js", capabilities: ["settings"] });
    const filePath = join(dir, "demo.js");
    const scan = readDeployedManifests(filePath);
    expect(scan.loaded).toEqual([]);
    expect(scan.failed).toHaveLength(1);
    expect(scan.failed[0].pluginId).toBe("plugin-dir");
    expect(scan.failed[0].detail).toContain(filePath);
  });

  it("reports a manifest whose id does not match its filename", () => {
    const dir = home();
    write(dir, "demo", { id: "different", api: 1, entry: "dist/index.js", capabilities: ["settings"] });
    const scan = readDeployedManifests(dir);
    expect(scan.loaded).toEqual([]);
    expect(scan.failed).toHaveLength(1);
    expect(scan.failed[0].pluginId).toBe("demo");
    expect(scan.failed[0].detail).toContain("different");
    expect(scan.failed[0].detail).toContain("demo");
  });

  it("reports when a manifest id does not match another plugin and allows only valid ones", () => {
    const dir = home();
    write(dir, "good1", { id: "good1", api: 1, entry: "dist/index.js", capabilities: ["settings"] });
    write(dir, "good2", { id: "good2", api: 1, entry: "dist/index.js", capabilities: ["settings"] });
    write(dir, "bad", { id: "wrong", api: 1, entry: "dist/index.js", capabilities: ["settings"] });
    const scan = readDeployedManifests(dir);
    expect(scan.loaded.map(p => p.manifest.id)).toEqual(["good1", "good2"]);
    expect(scan.failed).toHaveLength(1);
    expect(scan.failed[0].pluginId).toBe("bad");
    expect(scan.failed[0].detail).toContain("wrong");
    expect(scan.failed[0].detail).toContain("bad");
  });
});
