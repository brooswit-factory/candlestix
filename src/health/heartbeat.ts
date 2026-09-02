// Positive-heartbeat store.
//
// Contract for callers (the future supervisor loop, most importantly):
// call `recordHeartbeat(subjectId)` WHEN, AND ONLY WHEN, a cycle for that
// subject has genuinely completed. Not when a cycle starts. Not because no
// error was thrown. Not because the process is still running. Liveness here
// is defined exclusively as "a cycle finished and told us so" — never
// derived from the absence of a failure signal.
//
// This store also has to make a second distinction, separate from
// staleness: a subject can be UNTRACKED (nobody ever told this store the
// subject exists at all) versus TRACKED-BUT-NEVER-COMPLETED (the caller
// registered the subject — e.g. the roster says it should exist — but no
// cycle has finished yet). Those are different facts. Collapsing them lets
// "I have never heard of this subject" read as "this subject is fine" or
// as "this subject is dead," and both are lies. `getHeartbeat` returns a
// value that keeps them apart; `staleness.ts` is what turns that into a
// verdict.
export interface HeartbeatLookup {
  /**
   * false: this store has never been told this subject exists — not
   * tracked, not observed, no opinion. A caller asking about a subject
   * outside this store's scope gets this, never a definite health verdict.
   */
  readonly tracked: boolean;
  /**
   * Only meaningful when `tracked` is true. `null` means the subject is
   * known (registered, or a roster entry) but has not yet completed a
   * single cycle — that is a "stale" fact, not a "healthy" one.
   */
  readonly lastHeartbeat: Date | null;
}

export interface HeartbeatStore {
  /**
   * Marks a subject as known to this store without asserting it is
   * healthy. Idempotent. Use this when a subject becomes something this
   * process is responsible for (e.g. the roster names it) before it has
   * necessarily completed a cycle.
   */
  registerSubject(subjectId: string): void;

  /**
   * Record that `subjectId` completed a cycle at `at` (defaults to now).
   * Call this WHEN, AND ONLY WHEN, the cycle genuinely completed — see the
   * module doc comment above. Implicitly registers the subject if it was
   * not already tracked, since a completed cycle is strictly stronger
   * evidence of existence than an explicit registration.
   */
  recordHeartbeat(subjectId: string, at?: Date): void;

  /** Look up what this store knows about `subjectId`. Never throws. */
  getHeartbeat(subjectId: string): HeartbeatLookup;

  /** All subject ids this store currently tracks, registered or not. */
  listTrackedSubjects(): string[];
}

/** In-memory heartbeat store. One process's worth of scope — see README. */
export function createHeartbeatStore(): HeartbeatStore {
  const lastHeartbeatBySubject = new Map<string, Date | null>();

  return {
    registerSubject(subjectId: string): void {
      if (!lastHeartbeatBySubject.has(subjectId)) {
        lastHeartbeatBySubject.set(subjectId, null);
      }
    },

    recordHeartbeat(subjectId: string, at: Date = new Date()): void {
      lastHeartbeatBySubject.set(subjectId, at);
    },

    getHeartbeat(subjectId: string): HeartbeatLookup {
      if (!lastHeartbeatBySubject.has(subjectId)) {
        return { tracked: false, lastHeartbeat: null };
      }
      return { tracked: true, lastHeartbeat: lastHeartbeatBySubject.get(subjectId) ?? null };
    },

    listTrackedSubjects(): string[] {
      return [...lastHeartbeatBySubject.keys()];
    },
  };
}
