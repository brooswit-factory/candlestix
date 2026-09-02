import type { HeartbeatLookup } from "./heartbeat";

// Pure staleness evaluator. No clock read, no filesystem, no I/O, no
// ambient state: every input it needs — the heartbeat lookup, "now", and
// the threshold — is a parameter. That is what makes it unit-testable
// without mocking time, and it is deliberate: this module must be
// checkable by a test that asserts an exact answer for an exact input,
// the same discipline `log.ts`'s `formatLogLine` already uses (clock
// passed in, never read internally).
export type StalenessVerdict =
  | { kind: "healthy"; lastHeartbeat: Date }
  | { kind: "stale"; lastHeartbeat: Date | null }
  | { kind: "unknown" };

/**
 * Default staleness threshold: 90 seconds.
 *
 * The supervisor loop that will call `recordHeartbeat` every cycle does
 * not exist yet (a later story), so there is no measured cycle interval
 * to anchor this to. Absent that, 90s is chosen as "generous enough that
 * one unlucky slow cycle does not trip the alarm, tight enough that a
 * genuinely dead loop is caught within about a minute and a half" — three
 * times an assumed ~30s cycle cadence, the same reasoning a retry budget
 * uses: tolerate one miss, do not tolerate two. This is a starting point,
 * not a measured constant — expected to be revisited once a real
 * supervisor loop gives an actual cycle interval to anchor it to.
 */
export const DEFAULT_STALENESS_THRESHOLD_MS = 90_000;

/**
 * (lookup, now, threshold) -> verdict. Pure.
 *
 * Boundary rule, stated so it is a decision rather than an accident: an
 * age exactly equal to `thresholdMs` is still `healthy`. Staleness
 * requires the age to exceed the threshold, not merely reach it.
 *
 * `unknown` is returned if, and only if, `lookup.tracked` is false. There
 * is no other path to `unknown` and no path from an untracked lookup to
 * `healthy` or `stale` — a subject this evaluator was never told about
 * cannot receive a definite verdict, by construction, not by convention.
 */
export function evaluateStaleness(
  lookup: HeartbeatLookup,
  now: Date,
  thresholdMs: number
): StalenessVerdict {
  if (!lookup.tracked) {
    return { kind: "unknown" };
  }

  if (lookup.lastHeartbeat === null) {
    // Tracked (the roster/caller knows this subject exists) but no cycle
    // has ever completed. That is a fact about liveness, not an absence
    // of one: "never started" must not read as "fine".
    return { kind: "stale", lastHeartbeat: null };
  }

  const ageMs = now.getTime() - lookup.lastHeartbeat.getTime();
  if (ageMs > thresholdMs) {
    return { kind: "stale", lastHeartbeat: lookup.lastHeartbeat };
  }
  return { kind: "healthy", lastHeartbeat: lookup.lastHeartbeat };
}
