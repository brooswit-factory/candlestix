import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry, saveRegistry, pathExists } from "../../src/registry-store";
import { emptyRegistry, upsertRegistryEntry, type RegistryEntry } from "../../src/registry";

const entry: RegistryEntry = {
  agentId: "@0000000000abcdefghj",
  agentName: "a",
  sessionShortId: "abc",
  sessionId: "abc-full",
  cwd: "/tmp",
  spawnedAt: "2026-09-02T00:00:00.000Z",
};

describe("registry-store", () => {
  test("loadRegistry returns empty (not an error) for a missing file — first run", async () => {
    const registry = await loadRegistry("/definitely/does/not/exist/registry.json");
    expect(registry).toEqual(emptyRegistry());
  });

  test("loadRegistry returns empty and logs, rather than throwing, for malformed content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "candlestix-registry-"));
    try {
      const path = join(dir, "registry.json");
      await writeFile(path, "{not json", "utf8");
      const registry = await loadRegistry(path);
      expect(registry).toEqual(emptyRegistry());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("CNDLX-19 T4: loadRegistry discards a recognised pre-CNDLX-19 legacy (version 1, name-keyed) file and starts empty — not treated as malformed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "candlestix-registry-"));
    try {
      const path = join(dir, "registry.json");
      const legacy = {
        version: 1,
        agents: {
          "release-notes": {
            name: "release-notes",
            id: "179b2dfc",
            sessionId: "179b2dfc-full",
            cwd: "/home/operator/code/candlestix",
            spawnedAt: "2026-09-02T00:00:00.000Z",
          },
        },
      };
      await writeFile(path, JSON.stringify(legacy), "utf8");
      const registry = await loadRegistry(path);
      expect(registry).toEqual(emptyRegistry());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("saveRegistry then loadRegistry round-trips, creating parent directories as needed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "candlestix-registry-"));
    try {
      const path = join(dir, "nested", "registry.json");
      const registry = upsertRegistryEntry(emptyRegistry(), entry);
      await saveRegistry(path, registry);
      const loaded = await loadRegistry(path);
      expect(loaded).toEqual(registry);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("saveRegistry writes atomically: no .tmp file left behind after a successful write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "candlestix-registry-"));
    try {
      const path = join(dir, "registry.json");
      await saveRegistry(path, emptyRegistry());
      const contents = await readFile(path, "utf8");
      expect(JSON.parse(contents)).toEqual(emptyRegistry());
      const { readdir } = await import("node:fs/promises");
      const files = await readdir(dir);
      expect(files.every((f) => !f.endsWith(".tmp"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("pathExists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "candlestix-exists-"));
    try {
      expect(await pathExists(dir)).toBe(true);
      expect(await pathExists(join(dir, "nope"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
