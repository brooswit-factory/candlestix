import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHeartbeatStore } from "../../../src/health/heartbeat";
import { buildHealthSnapshot, startHealthSignalWriter, writeHealthSignal } from "../../../src/health/signal";

const THRESHOLD_MS = 60_000;
const NOW = new Date("2026-01-01T00:10:00.000Z");

describe("buildHealthSnapshot", () => {
  test("states its own scope and only lists subjects this store tracks", () => {
    const store = createHeartbeatStore();
    store.recordHeartbeat("healthy-one", new Date(NOW.getTime() - 1_000));
    store.recordHeartbeat("stale-one", new Date(NOW.getTime() - THRESHOLD_MS - 1));

    const snapshot = buildHealthSnapshot(store, NOW, THRESHOLD_MS);

    expect(snapshot.scope.statement.length).toBeGreaterThan(0);
    expect(typeof snapshot.scope.host).toBe("string");
    expect(snapshot.scope.pid).toBe(process.pid);
    expect(snapshot.subjects).toEqual([
      { subjectId: "healthy-one", verdict: "healthy", lastHeartbeat: new Date(NOW.getTime() - 1_000).toISOString() },
      {
        subjectId: "stale-one",
        verdict: "stale",
        lastHeartbeat: new Date(NOW.getTime() - THRESHOLD_MS - 1).toISOString(),
      },
    ]);
  });

  test("never fabricates an entry for a subject nobody registered", () => {
    const store = createHeartbeatStore();
    store.registerSubject("only-this-one");

    const snapshot = buildHealthSnapshot(store, NOW, THRESHOLD_MS);

    expect(snapshot.subjects.map((s) => s.subjectId)).toEqual(["only-this-one"]);
  });
});

describe("writeHealthSignal", () => {
  test("writes a complete, parseable JSON file — never a truncated one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "candlestix-health-test-"));
    const path = join(dir, "health.json");
    try {
      const store = createHeartbeatStore();
      store.recordHeartbeat("agent", new Date(NOW.getTime() - THRESHOLD_MS - 1));
      const snapshot = buildHealthSnapshot(store, NOW, THRESHOLD_MS);

      await writeHealthSignal(path, snapshot);

      const contents = await readFile(path, "utf8");
      expect(JSON.parse(contents)).toEqual(snapshot);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a second write replaces the first via rename, leaving no temp file behind", async () => {
    const dir = await mkdtemp(join(tmpdir(), "candlestix-health-test-"));
    const path = join(dir, "health.json");
    try {
      const store = createHeartbeatStore();
      store.recordHeartbeat("agent", NOW);

      await writeHealthSignal(path, buildHealthSnapshot(store, NOW, THRESHOLD_MS));
      const later = new Date(NOW.getTime() + THRESHOLD_MS + 1);
      await writeHealthSignal(path, buildHealthSnapshot(store, later, THRESHOLD_MS));

      const contents = JSON.parse(await readFile(path, "utf8"));
      expect(contents.generatedAt).toBe(later.toISOString());

      const { readdir } = await import("node:fs/promises");
      const filesLeftBehind = await readdir(dir);
      expect(filesLeftBehind).toEqual(["health.json"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("startHealthSignalWriter", () => {
  // A synchronous throw from the store must not crash the process (an
  // uncaught throw inside a setInterval callback does exactly that,
  // verified empirically while building this) or permanently stop the
  // writer. Fails if onError is only ever called once instead of on every
  // tick, or if the process crashes outright.
  test("keeps ticking on schedule and routes a synchronous throw to onError instead of crashing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "candlestix-health-test-"));
    const path = join(dir, "health.json");
    try {
      const throwingStore = {
        listTrackedSubjects(): string[] {
          throw new Error("a store method that fails unexpectedly");
        },
        getHeartbeat: () => ({ tracked: false, lastHeartbeat: null }),
      };

      let errors = 0;
      const writer = startHealthSignalWriter({
        store: throwingStore,
        path,
        intervalMs: 10,
        thresholdMs: THRESHOLD_MS,
        onError: () => {
          errors += 1;
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 55));
      writer.stop();

      expect(errors).toBeGreaterThanOrEqual(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
