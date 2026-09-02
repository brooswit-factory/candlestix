import { describe, expect, test } from "bun:test";
import { createHeartbeatStore } from "../../../src/health/heartbeat";
import { runAlarmTick, startStalenessAlarm } from "../../../src/health/alarm";

const THRESHOLD_MS = 60_000;
const NOW = new Date("2026-01-01T00:10:00.000Z");

describe("runAlarmTick", () => {
  // 6. The alarm fires when the evaluator says stale. Fails if a stale
  // subject never reaches onStale, or if onStale is never called at all.
  test("fires onStale for a subject the evaluator judges stale", () => {
    const store = createHeartbeatStore();
    store.recordHeartbeat("dead-loop", new Date(NOW.getTime() - THRESHOLD_MS - 1));

    const fired: string[] = [];
    runAlarmTick(store, NOW, THRESHOLD_MS, (subjectId) => fired.push(subjectId));

    expect(fired).toEqual(["dead-loop"]);
  });

  test("fires onStale for a tracked subject that never completed a cycle", () => {
    const store = createHeartbeatStore();
    store.registerSubject("never-started");

    const fired: string[] = [];
    runAlarmTick(store, NOW, THRESHOLD_MS, (subjectId) => fired.push(subjectId));

    expect(fired).toEqual(["never-started"]);
  });

  // 7. The alarm stays silent when the evaluator says unknown. Fails if
  // onStale is ever called for a subject this store never tracked.
  test("stays silent for subjects this store never tracked at all", () => {
    const store = createHeartbeatStore();
    // Nothing registered, nothing heartbeaten — store tracks zero subjects,
    // so there is nothing for runAlarmTick to iterate. Simulate a caller
    // asking about an out-of-scope subject via getHeartbeat directly to
    // confirm evaluateStaleness's own "unknown" path, exercised through
    // the same store the alarm reads.
    expect(store.getHeartbeat("someone-elses-daemon-manages-this").tracked).toBe(false);

    const fired: string[] = [];
    runAlarmTick(store, NOW, THRESHOLD_MS, (subjectId) => fired.push(subjectId));

    expect(fired).toEqual([]);
  });

  test("stays silent for a healthy subject", () => {
    const store = createHeartbeatStore();
    store.recordHeartbeat("healthy-loop", new Date(NOW.getTime() - 1_000));

    const fired: string[] = [];
    runAlarmTick(store, NOW, THRESHOLD_MS, (subjectId) => fired.push(subjectId));

    expect(fired).toEqual([]);
  });
});

describe("startStalenessAlarm", () => {
  // A throwing onStale must not permanently kill the timer: an uncaught
  // throw inside a setInterval callback crashes the whole Bun/Node
  // process (verified empirically while building this), which would
  // silently end every future tick. Fails if only one tick's worth of
  // calls is observed instead of several, or if the process actually
  // crashes (the test runner itself would report that).
  test("keeps ticking on its own schedule even after onStale throws", async () => {
    const store = createHeartbeatStore();
    store.recordHeartbeat("dead-loop", new Date(0));
    const thresholdMs = 1;

    let calls = 0;
    const alarm = startStalenessAlarm({
      store,
      intervalMs: 10,
      thresholdMs,
      now: () => new Date(),
      onStale: () => {
        calls += 1;
        throw new Error("a misbehaving onStale, e.g. a paging integration that fails");
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 55));
    alarm.stop();

    expect(calls).toBeGreaterThanOrEqual(3);
  });
});
