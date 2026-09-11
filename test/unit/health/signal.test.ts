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
      { subjectId: "healthy-one", agentName: undefined, verdict: "healthy", lastHeartbeat: new Date(NOW.getTime() - 1_000).toISOString() },
      {
        subjectId: "stale-one",
        agentName: undefined,
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

  test("CNDLX-19 T4: carries the store's display name for legibility — an id-only signal an operator cannot map back to an agent is a regression", () => {
    const store = createHeartbeatStore();
    store.recordHeartbeat("@01agentid", new Date(NOW.getTime() - 1_000), "release-notes");

    const snapshot = buildHealthSnapshot(store, NOW, THRESHOLD_MS);

    expect(snapshot.subjects).toEqual([
      { subjectId: "@01agentid", agentName: "release-notes", verdict: "healthy", lastHeartbeat: new Date(NOW.getTime() - 1_000).toISOString() },
    ]);
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
  //
  // This drives the real `startHealthSignalWriter` on the real system
  // clock — deliberately, so the assertion proves the writer actually
  // keeps ticking on its own schedule with nobody polling it, not just
  // that a mock was called. CNDLX-37: rather than sleep a fixed window and
  // then count ticks (a shape measured flaky under load — see the ticket),
  // wait for the ticks themselves, with a ceiling far past any plausible
  // stall. See alarm.test.ts's matching test for the full justification of
  // why scheduler jitter can only make this slower, never wrong.
  test("keeps ticking on schedule and routes a synchronous throw to onError instead of crashing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "candlestix-health-test-"));
    const path = join(dir, "health.json");
    try {
      const throwingStore = {
        listTrackedSubjects(): string[] {
          throw new Error("a store method that fails unexpectedly");
        },
        getHeartbeat: () => ({ tracked: false, lastHeartbeat: null, displayName: undefined }),
      };

      const REQUIRED_TICKS = 3;
      const TICK_WAIT_CEILING_MS = 5_000;

      let errors = 0;
      let resolveTicksObserved: () => void = () => {};
      const ticksObserved = new Promise<void>((resolve) => {
        resolveTicksObserved = resolve;
      });

      const writer = startHealthSignalWriter({
        store: throwingStore,
        path,
        intervalMs: 10,
        thresholdMs: THRESHOLD_MS,
        onError: () => {
          errors += 1;
          if (errors === REQUIRED_TICKS) resolveTicksObserved();
        },
      });

      let ceilingTimer: ReturnType<typeof setTimeout> | undefined;
      const ceiling = new Promise<void>((resolve) => {
        ceilingTimer = setTimeout(resolve, TICK_WAIT_CEILING_MS);
      });
      await Promise.race([ticksObserved, ceiling]);
      clearTimeout(ceilingTimer);
      writer.stop();

      // Equivalent strength to the original "≥3 errors happened": we now
      // wait until 3 errors happen or the ceiling elapses, so a defect
      // that stops ticking after the first throw still leaves `errors`
      // below 3 here and this still fails.
      expect(errors).toBeGreaterThanOrEqual(REQUIRED_TICKS);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
