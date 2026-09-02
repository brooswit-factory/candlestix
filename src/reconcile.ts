import type { BackgroundAgentInfo } from "./agents-cli";
import type { RegistryEntry } from "./registry";

// Pure reconcile decision for a single roster agent. No fs, no
// child_process, no clock read, no ambient state — every input this needs
// is a parameter, the same discipline `staleness.ts` uses, and for the
// same reason: "an agent gets a heartbeat" is exactly the kind of decision
// this ticket says must be exhaustively testable without mocking a
// filesystem or a subprocess.
//
// The heartbeat contract this exists to honour (see health/heartbeat.ts):
// record a heartbeat WHEN, AND ONLY WHEN, this agent's cycle genuinely
// completed — i.e. candlestix positively, independently confirmed it is
// alive, or positively confirmed a fresh spawn succeeded. "Listed by
// `claude agents --json`" alone is deliberately NOT sufficient — see
// `verifiedAlivePids` below and `agents-cli.ts`'s doc comment for the real,
// observed reason.
//
// DELIBERATE DECISION: the `wait` action (below) is unbounded — there is no
// consecutive-cycle counter, no escalation to `spawn` after N cycles of
// `wait`. A candidate that stays listed without a verifiable pid blocks
// `spawn` for that roster entry indefinitely. This was considered, not
// merely left unexamined: the alternative (falling through to `spawn`
// after some bound) can spawn a genuine duplicate next to a session that
// was never actually dead, only slow to re-verify — which is a strictly
// worse failure than staying stuck, because it silently creates two
// background sessions for one roster entry instead of loudly reporting
// zero. `wait` never fabricates health: the heartbeat stops, the subject
// goes `stale` (health/staleness.ts), and `startStalenessAlarm` gets loud
// on its own — exactly the mechanism this product already has for "an
// operator needs to look at this," used here instead of guessing. See
// README "Known gaps" for the same reasoning in operator-facing terms.

export interface ReconcileInputs {
  agentName: string;
  agentCwd: string;
  /** What candlestix's own registry currently believes backs this agent, if anything. */
  registryEntry: RegistryEntry | undefined;
  /** This cycle's full `claude agents --json` listing (already filtered to kind: "background" by the caller). */
  backgroundAgents: BackgroundAgentInfo[];
  /**
   * pids that the caller independently confirmed alive via `kill(pid, 0)`
   * (or equivalent) AT THE SAME MOMENT `backgroundAgents` was fetched.
   *
   * Two different claims, kept deliberately distinct (see the README's
   * "The registry" section for the architecture-level version of this):
   * as a per-check comparison against classic pid+start-time pairing, THIS
   * CHECK ALONE is weaker — it only rules out a `pid` claude's daemon
   * *just* reported now being invalid within that same instant (e.g. a
   * race in its own bookkeeping), not a recycled pid observed later. But
   * candlestix's ARCHITECTURE around this check is stronger than what
   * pid+start-time pairing exists to fix: candlestix never carries a pid
   * *across* a reconcile cycle in the first place (see "The registry" in
   * the README), so the classic "recycled pid from an old cycle" failure
   * this check's weaker cousin would need pairing to catch cannot arise
   * here at all — there is no stale, candlestix-held pid to recycle.
   */
  verifiedAlivePids: ReadonlySet<number>;
  /** Whether `agentCwd` currently exists on disk, checked fresh this cycle. */
  cwdExists: boolean;
}

export type ReconcileAction =
  | { type: "heartbeat"; entry: RegistryEntry }
  | { type: "spawn" }
  | { type: "wait"; reason: string }
  | { type: "cwd-missing" };

function findCandidate(
  registryEntry: RegistryEntry | undefined,
  backgroundAgents: BackgroundAgentInfo[],
  agentCwd: string
): BackgroundAgentInfo | undefined {
  if (registryEntry) {
    const byIdentity = backgroundAgents.find(
      (a) => a.sessionId === registryEntry.sessionId || a.id === registryEntry.id
    );
    if (byIdentity) return byIdentity;
  }
  // Adoption fallback: no registry entry (fresh install, or the registry
  // file was lost) does not mean no agent is running — `claude`'s own
  // background-session daemon persists independently of candlestix, so an
  // agent for this roster entry may already be alive. Matching by cwd is
  // how a lost registry self-heals from ground truth instead of spawning a
  // duplicate. Ambiguous only if two DIFFERENT background sessions happen
  // to share this exact cwd, in which case the first match is adopted and
  // this is a known, named limitation (see README) rather than a silent one.
  return backgroundAgents.find((a) => a.cwd === agentCwd);
}

export function decideReconcileAction(inputs: ReconcileInputs): ReconcileAction {
  const candidate = findCandidate(inputs.registryEntry, inputs.backgroundAgents, inputs.agentCwd);

  if (candidate) {
    if (candidate.pid !== undefined && inputs.verifiedAlivePids.has(candidate.pid)) {
      // spawnedAt is carried forward from the registry ONLY when the
      // candidate is genuinely the SAME session the registry already knew
      // about (matched by sessionId) — never merely because a registry
      // entry happened to exist for this name. A cwd-adoption match, or a
      // fresh spawn that replaced a session the registry hadn't caught up
      // to yet, is a DIFFERENT session under the same roster name, and
      // must get its own spawnedAt (candidate.startedAt), not inherit a
      // predecessor's. Getting this wrong would make the registry lie
      // about how long the CURRENT process has actually been running.
      const sameSessionAsRegistry = inputs.registryEntry?.sessionId === candidate.sessionId;
      return {
        type: "heartbeat",
        entry: {
          name: inputs.agentName,
          id: candidate.id,
          sessionId: candidate.sessionId,
          cwd: candidate.cwd,
          spawnedAt: sameSessionAsRegistry ? inputs.registryEntry!.spawnedAt : new Date(candidate.startedAt).toISOString(),
        },
      };
    }
    return {
      type: "wait",
      reason:
        candidate.pid === undefined
          ? `session "${candidate.id}" is listed but claude's daemon reported no pid for it this cycle`
          : `session "${candidate.id}" reported pid ${candidate.pid}, which did not independently verify as alive`,
    };
  }

  if (!inputs.cwdExists) {
    return { type: "cwd-missing" };
  }

  return { type: "spawn" };
}
