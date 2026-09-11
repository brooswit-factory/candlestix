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
  //
  // This drives the real `startStalenessAlarm` on the real system clock —
  // deliberately, so the assertion proves the alarm actually fires on its
  // own schedule with nobody polling it, not just that a mock was called.
  // CNDLX-37: rather than sleep a fixed window and then count ticks (which
  // made the assertion a function of OS scheduler jitter — see the ticket
  // for the measured flake), wait for the ticks themselves, with a ceiling
  // far past any plausible stall. Scheduler jitter can now only make this
  // slower, never wrong: REQUIRED_TICKS is reached in ~30ms when the
  // machine is idle, and however long a stalled scheduler needs under
  // load, right up to the ceiling. The only way to hit the ceiling is
  // either the process being starved of CPU for multiple seconds straight
  // (which would be failing the rest of the suite too, not just this
  // test) or a real defect that stopped the timer after the first throw —
  // exactly the regression this test exists to catch.
  test("keeps ticking on its own schedule even after onStale throws", async () => {
    const store = createHeartbeatStore();
    store.recordHeartbeat("dead-loop", new Date(0));
    const thresholdMs = 1;

    const REQUIRED_TICKS = 3;
    const TICK_WAIT_CEILING_MS = 5_000;

    let calls = 0;
    let resolveTicksObserved: () => void = () => {};
    const ticksObserved = new Promise<void>((resolve) => {
      resolveTicksObserved = resolve;
    });

    const alarm = startStalenessAlarm({
      store,
      intervalMs: 10,
      thresholdMs,
      now: () => new Date(),
      onStale: () => {
        calls += 1;
        if (calls === REQUIRED_TICKS) resolveTicksObserved();
        throw new Error("a misbehaving onStale, e.g. a paging integration that fails");
      },
    });

    let ceilingTimer: ReturnType<typeof setTimeout> | undefined;
    const ceiling = new Promise<void>((resolve) => {
      ceilingTimer = setTimeout(resolve, TICK_WAIT_CEILING_MS);
    });
    await Promise.race([ticksObserved, ceiling]);
    clearTimeout(ceilingTimer);
    alarm.stop();

    // Equivalent strength to the original "≥3 ticks happened": we now wait
    // until 3 ticks happen or the ceiling elapses, so a defect that stops
    // ticking after the first throw still leaves `calls` below 3 here and
    // this still fails.
    expect(calls).toBeGreaterThanOrEqual(REQUIRED_TICKS);
  });
});
