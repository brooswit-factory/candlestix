import type { HeartbeatStore } from "./heartbeat";
import { evaluateStaleness, type StalenessVerdict } from "./staleness";
import { log } from "../log";

/**
 * One evaluation pass over every subject a store tracks. Deterministic and
 * timer-free on purpose: it is what the unit tests below drive directly,
 * so "the alarm fires on stale" and "the alarm stays silent on unknown"
 * are assertions about real logic, not a mock standing in for a timer.
 * `startStalenessAlarm` is the only thing that puts this on a schedule.
 *
 * Fires `onStale` for every subject the evaluator calls `stale`. Never
 * fires for `unknown` — an alarm that cries wolf for every subject it
 * cannot see trains its own operator to ignore it, which is worse than
 * silence. Never fires for `healthy`, obviously.
 */
export function runAlarmTick(
  store: Pick<HeartbeatStore, "listTrackedSubjects" | "getHeartbeat">,
  now: Date,
  thresholdMs: number,
  onStale: (subjectId: string, verdict: Extract<StalenessVerdict, { kind: "stale" }>) => void
): void {
  for (const subjectId of store.listTrackedSubjects()) {
    const verdict = evaluateStaleness(store.getHeartbeat(subjectId), now, thresholdMs);
    if (verdict.kind === "stale") {
      onStale(subjectId, verdict);
    }
  }
}

function defaultOnStale(subjectId: string, verdict: Extract<StalenessVerdict, { kind: "stale" }>): void {
  const lastSeen = verdict.lastHeartbeat === null ? "never" : verdict.lastHeartbeat.toISOString();
  log("error", `STALE: subject "${subjectId}" has not completed a cycle since ${lastSeen}`);
}

export interface StalenessAlarmOptions {
  store: Pick<HeartbeatStore, "listTrackedSubjects" | "getHeartbeat">;
  /** How often the alarm checks, in ms. */
  intervalMs: number;
  /** Passed straight to `evaluateStaleness`. */
  thresholdMs: number;
  /** Injectable for tests; defaults to the real clock. */
  now?: () => Date;
  /** Defaults to an ERROR-level `log()` call — the documented floor for "loud". */
  onStale?: (subjectId: string, verdict: Extract<StalenessVerdict, { kind: "stale" }>) => void;
}

/**
 * Starts an independent timer that runs `runAlarmTick` on its own
 * schedule, with nobody polling it. This is the self-firing alarm.
 *
 * Why the loop it watches cannot silently kill it: `setInterval`'s
 * returned timer id is held ONLY in the closure below, and is never
 * exposed to, stored on, or reachable from the `HeartbeatStore` this
 * alarm reads. The store's own interface (`registerSubject`,
 * `recordHeartbeat`, `getHeartbeat`, `listTrackedSubjects`) has no method
 * that touches a timer at all — the loop that calls `recordHeartbeat`
 * every cycle has no path back to this interval, because nothing was
 * ever handed to it that could reach one. The only way to stop this alarm
 * is to hold the `stop()` returned here, which only the code that started
 * the alarm receives.
 *
 * `setInterval` itself also keeps the process's event loop open — the
 * same mechanism `src/index.ts` already relies on to stay alive for
 * signals — so this is not a fake capability that is registered and then
 * silently reaped when the process would otherwise exit.
 *
 * The tick body is wrapped in try/catch on purpose: an uncaught throw
 * inside a `setInterval` callback does not just skip one tick, it crashes
 * the whole process (verified empirically, not assumed) — which would
 * silently end every future tick and take the rest of the daemon down
 * with it. A misbehaving custom `onStale` (e.g. a paging integration that
 * throws) must not be able to do that; a caught tick logs and the next
 * one still runs on schedule.
 */
export function startStalenessAlarm(options: StalenessAlarmOptions): { stop(): void } {
  const now = options.now ?? (() => new Date());
  const onStale = options.onStale ?? defaultOnStale;

  const timer = setInterval(() => {
    try {
      runAlarmTick(options.store, now(), options.thresholdMs, onStale);
    } catch (error) {
      log("error", `staleness alarm tick threw and was caught, so the next tick still runs: ${String(error)}`);
    }
  }, options.intervalMs);

  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}
