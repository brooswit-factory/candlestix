import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HeartbeatStore } from "./heartbeat";
import { evaluateStaleness, type StalenessVerdict } from "./staleness";

// External health signal: a file, not a port, on purpose. An operator on
// this host can reach more than one daemon; a guessed port that happens
// to answer is a REAL answer from the WRONG daemon — exactly the "I have
// never heard of it is not it is dead" failure this ticket names, made
// easy by construction. A file at a path the operator chose, checked
// against the `scope` this signal states about itself, does not have that
// failure mode: there is no way to "guess" a file into answering for a
// process it isn't.

export interface HealthSignalVerdict {
  subjectId: string;
  verdict: StalenessVerdict["kind"];
  /** ISO 8601, or null if never observed / no heartbeat recorded yet. */
  lastHeartbeat: string | null;
}

export interface HealthSignalSnapshot {
  /**
   * States this signal's own scope, per the ticket's requirement: what it
   * does and does not observe. A reader must be able to tell "silent
   * about a subject this process watches" apart from "silent about a
   * subject it never watched" — that is exactly the distinction
   * `subjects` below preserves by only ever listing tracked subjects with
   * a real verdict, never fabricating an entry for anything else.
   */
  scope: {
    statement: string;
    host: string;
    pid: number;
  };
  generatedAt: string;
  thresholdMs: number;
  subjects: HealthSignalVerdict[];
}

const SCOPE_STATEMENT =
  "This signal reports ONLY the subjects registered with this process's own heartbeat store, as of `generatedAt`. " +
  "It does not observe, aggregate, or have an opinion about any other process, host, or Unix user — including another " +
  "candlestix daemon that may be running alongside this one. A subject absent from `subjects` was never observed by " +
  "this signal at all; that is a different fact from any entry present with verdict \"stale\", and must not be read as one.";

/**
 * Pure builder: (store, now, thresholdMs) -> snapshot. Kept separate from
 * the file write below so the shape of what gets reported is unit
 * testable without touching a filesystem.
 */
export function buildHealthSnapshot(
  store: Pick<HeartbeatStore, "listTrackedSubjects" | "getHeartbeat">,
  now: Date,
  thresholdMs: number
): HealthSignalSnapshot {
  const subjects: HealthSignalVerdict[] = store.listTrackedSubjects().map((subjectId) => {
    const verdict = evaluateStaleness(store.getHeartbeat(subjectId), now, thresholdMs);
    return {
      subjectId,
      verdict: verdict.kind,
      lastHeartbeat: verdict.kind === "unknown" ? null : verdict.lastHeartbeat?.toISOString() ?? null,
    };
  });

  return {
    scope: { statement: SCOPE_STATEMENT, host: hostname(), pid: process.pid },
    generatedAt: now.toISOString(),
    thresholdMs,
    subjects,
  };
}

/**
 * Writes `snapshot` to `path` atomically: write to a sibling temp file,
 * then `rename` over the target. `rename` on the same filesystem is
 * atomic at the OS level, so a concurrent reader either sees the old
 * complete file or the new complete file — never a half-written one. A
 * truncated read is not a possible outcome of this function, by
 * construction, not by convention.
 */
export async function writeHealthSignal(path: string, snapshot: HealthSignalSnapshot): Promise<void> {
  const tmpPath = join(dirname(path), `.${randomUUID()}.tmp`);
  await writeFile(tmpPath, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
  await rename(tmpPath, path);
}

export interface HealthSignalWriterOptions {
  store: Pick<HeartbeatStore, "listTrackedSubjects" | "getHeartbeat">;
  path: string;
  intervalMs: number;
  thresholdMs: number;
  now?: () => Date;
  onError?: (error: unknown) => void;
}

/**
 * Starts an independent timer that (re)writes the health signal file on
 * its own schedule — same "nobody has to ask at the right moment"
 * shape as the alarm, so the signal on disk cannot go stale itself
 * without anyone knowing there's a supervisor loop to blame.
 *
 * `writeOnce`'s synchronous portion (`buildHealthSnapshot`) is wrapped in
 * try/catch, not just the async write: a synchronous throw inside a
 * `setInterval` callback crashes the whole process (same fake-capability
 * risk as the alarm — see its doc comment), which `.catch(onError)` alone
 * would not have caught since it only wraps the promise returned by
 * `writeHealthSignal`.
 */
export function startHealthSignalWriter(options: HealthSignalWriterOptions): { stop(): void } {
  const now = options.now ?? (() => new Date());
  const onError = options.onError ?? (() => {});

  const writeOnce = (): void => {
    try {
      const snapshot = buildHealthSnapshot(options.store, now(), options.thresholdMs);
      writeHealthSignal(options.path, snapshot).catch(onError);
    } catch (error) {
      onError(error);
    }
  };

  writeOnce();
  const timer = setInterval(writeOnce, options.intervalMs);

  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}
