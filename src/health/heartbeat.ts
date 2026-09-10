// Positive-heartbeat store.
//
// Contract for callers (the supervisor loop, most importantly): call
// `recordHeartbeat(subjectId)` WHEN, AND ONLY WHEN, a cycle for that
// subject has genuinely completed. Not when a cycle starts. Not because no
// error was thrown. Not because the process is still running. Liveness here
// is defined exclusively as "a cycle finished and told us so" — never
// derived from the absence of a failure signal.
//
// This store also has to make a second distinction, separate from
// staleness: a subject can be UNTRACKED (nobody ever told this store the
// subject exists at all) versus TRACKED-BUT-NEVER-COMPLETED (the caller
// registered the subject — e.g. the durable agent set says it should be
// `on` — but no cycle has finished yet). Those are different facts.
// Collapsing them lets "I have never heard of this subject" read as "this
// subject is fine" or as "this subject is dead," and both are lies.
// `getHeartbeat` returns a value that keeps them apart; `staleness.ts` is
// what turns that into a verdict.
//
// CNDLX-19 T3: only `on` agents are heartbeat subjects, and an agent that
// leaves `on` (turned off, archived, or deleted) must stop being one —
// otherwise the staleness alarm fires forever for an agent the operator
// deliberately turned off, which is the product's one real
// "an operator needs to look at this" signal turned into permanent noise.
// `unregisterSubject` below is the removal verb this required; it did not
// exist before this ticket.
//
// CNDLX-19 T4: subjects are now keyed by the agent's durable id, never by
// its mutable name — the same re-keying this ticket applies to the session
// registry (see registry.ts). A name is still useful to a human reading
// the operator-facing health signal, so it is carried as `displayName` —
// explicitly a DISPLAY field, never a key, never consulted by any lookup
// in this module.
export interface HeartbeatLookup {
  /**
   * false: this store has never been told this subject exists — not
   * tracked, not observed, no opinion. A caller asking about a subject
   * outside this store's scope gets this, never a definite health verdict.
   */
  readonly tracked: boolean;
  /**
   * Only meaningful when `tracked` is true. `null` means the subject is
   * known (registered, or recorded `on`) but has not yet completed a
   * single cycle — that is a "stale" fact, not a "healthy" one.
   */
  readonly lastHeartbeat: Date | null;
  /** Display only (T4) — never a key, never matched against. */
  readonly displayName: string | undefined;
}

export interface HeartbeatStore {
  /**
   * Marks a subject as known to this store without asserting it is
   * healthy. Idempotent. Use this when a subject becomes something this
   * process is responsible for (e.g. its recorded state is `on`) before it
   * has necessarily completed a cycle. `displayName`, if given, is stored
   * or updated for the operator-facing signal; omitting it on a later call
   * leaves a previously-set name in place rather than clearing it.
   */
  registerSubject(subjectId: string, displayName?: string): void;

  /**
   * Record that `subjectId` completed a cycle at `at` (defaults to now).
   * Call this WHEN, AND ONLY WHEN, the cycle genuinely completed — see the
   * module doc comment above. Implicitly registers the subject if it was
   * not already tracked, since a completed cycle is strictly stronger
   * evidence of existence than an explicit registration.
   */
  recordHeartbeat(subjectId: string, at?: Date, displayName?: string): void;

  /**
   * T3: removes a subject entirely — this store no longer has any opinion
   * about it, exactly as if it had never been registered. Idempotent:
   * unregistering a subject that was never tracked, or already
   * unregistered, is a no-op, not an error.
   */
  unregisterSubject(subjectId: string): void;

  /** Look up what this store knows about `subjectId`. Never throws. */
  getHeartbeat(subjectId: string): HeartbeatLookup;

  /** All subject ids this store currently tracks, registered or not. */
  listTrackedSubjects(): string[];
}

interface TrackedSubject {
  lastHeartbeat: Date | null;
  displayName: string | undefined;
}

/** In-memory heartbeat store. One process's worth of scope — see README. */
export function createHeartbeatStore(): HeartbeatStore {
  const bySubject = new Map<string, TrackedSubject>();

  return {
    registerSubject(subjectId: string, displayName?: string): void {
      const existing = bySubject.get(subjectId);
      if (existing === undefined) {
        bySubject.set(subjectId, { lastHeartbeat: null, displayName });
      } else if (displayName !== undefined) {
        existing.displayName = displayName;
      }
    },

    recordHeartbeat(subjectId: string, at: Date = new Date(), displayName?: string): void {
      const existing = bySubject.get(subjectId);
      bySubject.set(subjectId, { lastHeartbeat: at, displayName: displayName ?? existing?.displayName });
    },

    unregisterSubject(subjectId: string): void {
      bySubject.delete(subjectId);
    },

    getHeartbeat(subjectId: string): HeartbeatLookup {
      const existing = bySubject.get(subjectId);
      if (existing === undefined) {
        return { tracked: false, lastHeartbeat: null, displayName: undefined };
      }
      return { tracked: true, lastHeartbeat: existing.lastHeartbeat, displayName: existing.displayName };
    },

    listTrackedSubjects(): string[] {
      return [...bySubject.keys()];
    },
  };
}
