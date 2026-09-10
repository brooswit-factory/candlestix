// CNDLX-23: the eight-verb action set, as plain callable functions. No CLI,
// no HTTP, no API, no UI — those are CNDLX-15's. `attach` is deliberately
// NOT here — it is CNDLX-3's, left a seam.
//
// Every action follows the same shape: load the store (refusing outright on
// `malformed` — never treated as empty, per CNDLX-17's own module doc),
// resolve `<id-or-name>` through CNDLX-17's ONE resolver when the verb takes
// one, consult the PURE decision in agent-lifecycle.ts, THEN apply effects
// (session stop/start via agent-session.ts / agent-spawn.ts, directory
// create/remove via agent-directory.ts), and only persist the store write
// AFTER every effect has succeeded — so a failed effect never leaves the
// durable store recording an intention this process just learned is false.
// This is R9's split, applied uniformly.
//
// The REVERSE direction — effect succeeded, but the store write itself then
// fails — is a distinct failure this module also owns honestly rather than
// leaving as an unhandled rejection: every `saveAgentSet` call is wrapped
// (`saveOrReportFailure` below) and reported as a typed `store-write-failed`
// member on the same error union every other failure uses, naming exactly
// which effect already happened (a session was stopped/started, a name was
// changed, ...) so the caller knows reality and the durable store may now
// disagree. This was found live, by review, not by reasoning: a `turnOff`
// whose session-stop effect succeeds and whose write then throws left the
// store recording `"on"` for an agent whose session was genuinely stopped —
// exactly the state CNDLX-19's reconcile loop must never see, since it would
// read "on" and respawn an agent the operator just turned off.

import type { AgentLifecycleState, AgentRecord } from "./agent";
import { checkAgentNameAllowed, decideArchive, decideDelete, decideOff, decideOn, decideUnarchive } from "./agent-lifecycle";
import { createAgentDirectory, removeAgentDirectory } from "./agent-directory";
import { spawnDaemonAgent } from "./agent-spawn";
import { stopAllSessionsUnderCwd, stopAndRemoveAllSessionsUnderCwd } from "./agent-session";
import type { RunCommand } from "./agents-cli";
import { deleteAgent as deleteAgentMutator, insertAgent, renameAgent as renameAgentMutator, type AgentSet } from "./agent-set";
import { loadAgentSet, saveAgentSet } from "./agent-set-store";
import { mintAgentId } from "./agent-id";
import { resolveAgent, type ResolveAgentError } from "./agent-resolver";

export interface AgentActionsDeps {
  agentSetPath: string;
  agentsBaseDir: string;
  agentDirectoryPath: (agentId: string) => string;
  mcpConfigPath: (agentId: string) => string;
  runCommand: RunCommand;
  now: () => Date;
  random: () => number;
}

/** Every action's first, shared refusal: a malformed store structurally cannot proceed (CNDLX-17's own reasoning, honoured here rather than re-decided). */
export type StoreTrouble = { kind: "store-malformed"; error: string };

/** Every session-lookup step (off/archive/delete) can fail to even SEE reality — surfaced honestly rather than treated as "no session found". */
export type SessionLookupTrouble = { kind: "session-lookup-failed"; error: string };

/** A resolved session was found but could not be stopped/removed — never silently ignored. */
export type SessionCleanupTrouble = { kind: "session-cleanup-failed"; failed: Array<{ id: string; error: string }> };

/**
 * The store write itself failed AFTER every effect already succeeded. The
 * message names what already happened (`effectDescription`) so the caller
 * knows precisely how reality and the durable store may now disagree —
 * this is never swallowed and never left as an unhandled rejection.
 */
export type StoreWriteTrouble = { kind: "store-write-failed"; error: string };

/**
 * Wraps every `saveAgentSet` call in this module. `effectDescription` is a
 * short, already-true clause ("the session was stopped") describing what
 * happened before this write was attempted — on failure it is folded into
 * the error message so the caller is told exactly what the durable store
 * may now be lying about, rather than merely that a write failed.
 */
async function saveOrReportFailure(
  agentSetPath: string,
  agentSet: AgentSet,
  effectDescription: string
): Promise<{ ok: true } | { ok: false; error: StoreWriteTrouble }> {
  try {
    await saveAgentSet(agentSetPath, agentSet);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: {
        kind: "store-write-failed",
        error: `${effectDescription}, but the durable store write failed — the store may now be STALE relative to reality: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
}

async function loadOrRefuse(agentSetPath: string): Promise<{ ok: true; agentSet: AgentSet } | { ok: false; error: StoreTrouble }> {
  const loaded = await loadAgentSet(agentSetPath);
  if (loaded.kind === "malformed") {
    return { ok: false, error: { kind: "store-malformed", error: loaded.error } };
  }
  return { ok: true, agentSet: loaded.agentSet };
}

async function resolveOrRefuse(
  agentSetPath: string,
  query: string
): Promise<{ ok: true; agentSet: AgentSet; agent: AgentRecord } | { ok: false; error: StoreTrouble | ResolveAgentError }> {
  const loaded = await loadOrRefuse(agentSetPath);
  if (!loaded.ok) return loaded;
  const resolved = resolveAgent(loaded.agentSet, query);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  return { ok: true, agentSet: loaded.agentSet, agent: resolved.agent };
}

async function stopSessionsOrTrouble(
  runCommand: RunCommand,
  cwd: string
): Promise<{ ok: true } | { ok: false; error: SessionLookupTrouble | SessionCleanupTrouble }> {
  let result: Awaited<ReturnType<typeof stopAllSessionsUnderCwd>>;
  try {
    result = await stopAllSessionsUnderCwd(runCommand, cwd);
  } catch (err) {
    return { ok: false, error: { kind: "session-lookup-failed", error: err instanceof Error ? err.message : String(err) } };
  }
  if (result.failed.length > 0) {
    return { ok: false, error: { kind: "session-cleanup-failed", failed: result.failed } };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// list (R10)
// ---------------------------------------------------------------------------

export type ListAgentsResult = { ok: true; agents: AgentRecord[] } | { ok: false; error: StoreTrouble };

/** R10: a plain projection over the store. `state` is on every record already, so CNDLX-15 (hide archived) and CNDLX-16 (Archived tab) need no second query. */
export async function listAgents(deps: Pick<AgentActionsDeps, "agentSetPath">): Promise<ListAgentsResult> {
  const loaded = await loadOrRefuse(deps.agentSetPath);
  if (!loaded.ok) return loaded;
  return { ok: true, agents: Object.values(loaded.agentSet.agents) };
}

// ---------------------------------------------------------------------------
// create (S5, S6, R11, R17)
// ---------------------------------------------------------------------------

export interface CreateAgentParams {
  name?: string;
  job?: string;
  /** S5: defaulted, not hardcoded — lets a create-but-do-not-start be expressed later without a new verb, and lets tests create records without spawning anything. */
  initialState?: "on" | "off";
}

export type CreateAgentError =
  | StoreTrouble
  | { kind: "invalid-name"; message: string }
  | { kind: "reserved-name"; word: string; message: string }
  | { kind: "name-taken"; holder: AgentRecord; message: string }
  | { kind: "directory-create-failed"; error: string }
  | { kind: "spawn-failed"; error: string }
  | StoreWriteTrouble;

export type CreateAgentResult = { ok: true; agent: AgentRecord } | { ok: false; error: CreateAgentError };

/**
 * S5's order: mint id -> create directory -> record -> THEN the start
 * effect (if `initialState` is `"on"`, the default). If the start effect
 * fails, this rolls back rather than persisting a state we just learned is
 * false: the directory just created is removed and NOTHING is written to
 * the store (`insertAgent`'s result is computed in memory but never saved
 * until every effect has succeeded).
 */
export async function createAgent(deps: AgentActionsDeps, params: CreateAgentParams = {}): Promise<CreateAgentResult> {
  const initialState: AgentLifecycleState = params.initialState ?? "on";
  const loaded = await loadOrRefuse(deps.agentSetPath);
  if (!loaded.ok) return loaded;

  if (params.name !== undefined) {
    const nameCheck = checkAgentNameAllowed(params.name);
    if (!nameCheck.ok) {
      return nameCheck.error.kind === "invalid-syntax"
        ? { ok: false, error: { kind: "invalid-name", message: nameCheck.error.message } }
        : { ok: false, error: { kind: "reserved-name", word: nameCheck.error.word, message: nameCheck.error.message } };
    }
  }

  const id = mintAgentId({ now: deps.now, random: deps.random });
  const record: AgentRecord = {
    id,
    ...(params.name !== undefined ? { name: params.name } : {}),
    ...(params.job !== undefined ? { job: params.job } : {}),
    state: initialState,
    createdAt: deps.now().toISOString(),
  };

  const inserted = insertAgent(loaded.agentSet, record);
  if (!inserted.ok) {
    const err = inserted.error;
    if (err.kind === "name-taken") return { ok: false, error: { kind: "name-taken", holder: err.holder, message: err.message } };
    if (err.kind === "invalid-name") return { ok: false, error: { kind: "invalid-name", message: err.message } };
    // id-already-used / id-retired / invalid-id: structurally unreachable for
    // a fresh mintAgentId() output against the set we just loaded it against,
    // but surfaced honestly rather than assumed away.
    return { ok: false, error: { kind: "store-malformed", error: `unexpected insertAgent refusal for a freshly minted id: ${err.kind}` } };
  }

  try {
    await createAgentDirectory(deps.agentDirectoryPath(id));
  } catch (err) {
    return { ok: false, error: { kind: "directory-create-failed", error: err instanceof Error ? err.message : String(err) } };
  }

  if (initialState === "on") {
    const spawnResult = await spawnDaemonAgent(record, deps.agentDirectoryPath(id), deps.mcpConfigPath(id), { runCommand: deps.runCommand });
    if (!spawnResult.ok) {
      await removeAgentDirectory(deps.agentsBaseDir, id); // best-effort: nothing was ever persisted to the store, so this is the only rollback needed.
      return { ok: false, error: { kind: "spawn-failed", error: spawnResult.error } };
    }
  }

  const effectDescription =
    initialState === "on" ? "the agent's directory was created and a session was started" : "the agent's directory was created";
  const saved = await saveOrReportFailure(deps.agentSetPath, inserted.agentSet, effectDescription);
  if (!saved.ok) {
    // Unlike every other verb below, a write failure HERE leaves an id that
    // exists nowhere in the store — a retry mints a fresh id and would never
    // revisit this one, so the directory/session just created would
    // otherwise leak forever. Roll back for real, best-effort, rather than
    // relying on a later `delete` that has nothing to resolve by.
    if (initialState === "on") {
      try {
        await stopAllSessionsUnderCwd(deps.runCommand, deps.agentDirectoryPath(id));
      } catch {
        // best-effort: the write-failure error below is what actually gets surfaced.
      }
    }
    await removeAgentDirectory(deps.agentsBaseDir, id);
    return saved;
  }
  return { ok: true, agent: record };
}

// ---------------------------------------------------------------------------
// on (S4's `on` column)
// ---------------------------------------------------------------------------

export type OnAgentError =
  | StoreTrouble
  | ResolveAgentError
  | { kind: "already-archived"; message: string }
  | { kind: "spawn-failed"; error: string }
  | StoreWriteTrouble;
export type OnAgentSuccess = { kind: "no-change" } | { kind: "turned-on" };
export type OnAgentResult = { ok: true; outcome: OnAgentSuccess } | { ok: false; error: OnAgentError };

export async function turnOn(deps: AgentActionsDeps, query: string): Promise<OnAgentResult> {
  const resolved = await resolveOrRefuse(deps.agentSetPath, query);
  if (!resolved.ok) return resolved;
  const { agentSet, agent } = resolved;

  const decision = decideOn(agent.state);
  if (decision.kind === "no-change") return { ok: true, outcome: { kind: "no-change" } };
  if (decision.kind === "refused") return { ok: false, error: { kind: "already-archived", message: decision.message } };

  const spawnResult = await spawnDaemonAgent(agent, deps.agentDirectoryPath(agent.id), deps.mcpConfigPath(agent.id), { runCommand: deps.runCommand });
  if (!spawnResult.ok) return { ok: false, error: { kind: "spawn-failed", error: spawnResult.error } };

  const updated: AgentRecord = { ...agent, state: "on" };
  const saved = await saveOrReportFailure(
    deps.agentSetPath,
    { ...agentSet, agents: { ...agentSet.agents, [agent.id]: updated } },
    "a new session was started"
  );
  if (!saved.ok) return saved;
  return { ok: true, outcome: { kind: "turned-on" } };
}

// ---------------------------------------------------------------------------
// off (S4's `off` column)
// ---------------------------------------------------------------------------

export type OffAgentError =
  | StoreTrouble
  | ResolveAgentError
  | ({ kind: "archived" } & { message: string })
  | SessionLookupTrouble
  | SessionCleanupTrouble
  | StoreWriteTrouble;
export type OffAgentSuccess = { kind: "no-change" } | { kind: "turned-off" };
export type OffAgentResult = { ok: true; outcome: OffAgentSuccess } | { ok: false; error: OffAgentError };

export async function turnOff(deps: AgentActionsDeps, query: string): Promise<OffAgentResult> {
  const resolved = await resolveOrRefuse(deps.agentSetPath, query);
  if (!resolved.ok) return resolved;
  const { agentSet, agent } = resolved;

  const decision = decideOff(agent.state);
  if (decision.kind === "no-change") return { ok: true, outcome: { kind: "no-change" } };
  if (decision.kind === "refused") return { ok: false, error: { kind: "archived", message: decision.message } };

  // S2: find and stop EVERY live session under this agent's exact
  // directory — never a registry keyed by name.
  const stopped = await stopSessionsOrTrouble(deps.runCommand, deps.agentDirectoryPath(agent.id));
  if (!stopped.ok) return stopped;

  const updated: AgentRecord = { ...agent, state: "off" };
  const saved = await saveOrReportFailure(
    deps.agentSetPath,
    { ...agentSet, agents: { ...agentSet.agents, [agent.id]: updated } },
    "the session was stopped"
  );
  if (!saved.ok) return saved;
  return { ok: true, outcome: { kind: "turned-off" } };
}

// ---------------------------------------------------------------------------
// archive (S4's `archive` column)
// ---------------------------------------------------------------------------

export type ArchiveAgentError =
  | StoreTrouble
  | ResolveAgentError
  | { kind: "already-archived"; message: string }
  | SessionLookupTrouble
  | SessionCleanupTrouble
  | StoreWriteTrouble;
export type ArchiveAgentSuccess = { kind: "archived" };
export type ArchiveAgentResult = { ok: true; outcome: ArchiveAgentSuccess } | { ok: false; error: ArchiveAgentError };

export async function archiveAgent(deps: AgentActionsDeps, query: string): Promise<ArchiveAgentResult> {
  const resolved = await resolveOrRefuse(deps.agentSetPath, query);
  if (!resolved.ok) return resolved;
  const { agentSet, agent } = resolved;

  const decision = decideArchive(agent.state);
  if (decision.kind === "refused") return { ok: false, error: { kind: "already-archived", message: decision.message } };

  if (decision.effect === "stop-session") {
    const stopped = await stopSessionsOrTrouble(deps.runCommand, deps.agentDirectoryPath(agent.id));
    if (!stopped.ok) return stopped;
  }

  const updated: AgentRecord = { ...agent, state: "archived" };
  const effectDescription = decision.effect === "stop-session" ? "the session was stopped" : "no session needed stopping";
  const saved = await saveOrReportFailure(
    deps.agentSetPath,
    { ...agentSet, agents: { ...agentSet.agents, [agent.id]: updated } },
    effectDescription
  );
  if (!saved.ok) return saved;
  return { ok: true, outcome: { kind: "archived" } };
}

// ---------------------------------------------------------------------------
// unarchive (S4's `unarchive` column — lands on `off`, NEVER `on`)
// ---------------------------------------------------------------------------

export type UnarchiveAgentError = StoreTrouble | ResolveAgentError | { kind: "not-archived"; message: string } | StoreWriteTrouble;
export type UnarchiveAgentSuccess = { kind: "unarchived" };
export type UnarchiveAgentResult = { ok: true; outcome: UnarchiveAgentSuccess } | { ok: false; error: UnarchiveAgentError };

export async function unarchiveAgent(deps: AgentActionsDeps, query: string): Promise<UnarchiveAgentResult> {
  const resolved = await resolveOrRefuse(deps.agentSetPath, query);
  if (!resolved.ok) return resolved;
  const { agentSet, agent } = resolved;

  const decision = decideUnarchive(agent.state);
  if (decision.kind === "refused") return { ok: false, error: { kind: "not-archived", message: decision.message } };

  const updated: AgentRecord = { ...agent, state: "off" };
  const saved = await saveOrReportFailure(
    deps.agentSetPath,
    { ...agentSet, agents: { ...agentSet.agents, [agent.id]: updated } },
    "no session change was made (unarchive never starts a session)"
  );
  if (!saved.ok) return saved;
  return { ok: true, outcome: { kind: "unarchived" } };
}

// ---------------------------------------------------------------------------
// rename (R2, R17) — never moves the directory or any id-keyed path (R16)
// ---------------------------------------------------------------------------

export type RenameAgentError =
  | StoreTrouble
  | ResolveAgentError
  | { kind: "invalid-name"; message: string }
  | { kind: "reserved-name"; word: string; message: string }
  | { kind: "name-taken"; holder: AgentRecord; message: string }
  | StoreWriteTrouble;

export type RenameAgentResult = { ok: true; agent: AgentRecord } | { ok: false; error: RenameAgentError };

/**
 * Legal regardless of lifecycle state (S4: "a name is a label, state is
 * irrelevant") — no state-based decision to consult here, unlike
 * on/off/archive/unarchive. Reuses CNDLX-17's `renameAgent` mutator for R2
 * rather than re-implementing it; layers R17's reserved-word check on top
 * via `checkAgentNameAllowed`, the one place both `create` and `rename`
 * consult. Touches ONLY the store's `name` field — never the directory
 * (agentDirectoryPath) or the MCP config path (agentMcpConfigPath), both
 * keyed by `id`, not `name` — so "a rename never moves the directory" (and,
 * post-R16, never moves the MCP config either) holds by construction, not
 * by remembering not to touch them.
 */
export async function renameAgent(deps: Pick<AgentActionsDeps, "agentSetPath">, query: string, newName: string): Promise<RenameAgentResult> {
  const resolved = await resolveOrRefuse(deps.agentSetPath, query);
  if (!resolved.ok) return resolved;
  const { agentSet, agent } = resolved;

  const nameCheck = checkAgentNameAllowed(newName);
  if (!nameCheck.ok) {
    return nameCheck.error.kind === "invalid-syntax"
      ? { ok: false, error: { kind: "invalid-name", message: nameCheck.error.message } }
      : { ok: false, error: { kind: "reserved-name", word: nameCheck.error.word, message: nameCheck.error.message } };
  }

  const renamed = renameAgentMutator(agentSet, agent.id, newName);
  if (!renamed.ok) {
    const err = renamed.error;
    if (err.kind === "name-taken") return { ok: false, error: { kind: "name-taken", holder: err.holder, message: err.message } };
    if (err.kind === "invalid-name") return { ok: false, error: { kind: "invalid-name", message: err.message } };
    // not-found: structurally unreachable — `agent` was just resolved from this exact `agentSet`.
    return { ok: false, error: { kind: "store-malformed", error: "renameAgent refused 'not-found' for an agent just resolved from the same set" } };
  }

  const saved = await saveOrReportFailure(deps.agentSetPath, renamed.agentSet, "the name was accepted");
  if (!saved.ok) return saved;
  return { ok: true, agent: renamed.agentSet.agents[agent.id] as AgentRecord };
}

// ---------------------------------------------------------------------------
// delete (S3, S4's `delete` column — the one destructive verb)
// ---------------------------------------------------------------------------

export type DeleteAgentError =
  | StoreTrouble
  | ResolveAgentError
  | SessionLookupTrouble
  | SessionCleanupTrouble
  | { kind: "directory-removal-failed"; reason: string }
  | StoreWriteTrouble;

export type DeleteAgentSuccess = { kind: "deleted" };
export type DeleteAgentResult = { ok: true; outcome: DeleteAgentSuccess } | { ok: false; error: DeleteAgentError };

/**
 * S3's exact ordering: stop the live session (if any) -> remove the
 * session and its conversation -> remove the agent's directory ->
 * `deleteAgent` in the store (retires the id, frees the name). Legal from
 * any known state (`decideDelete` is unconditional — called here only for
 * the pure-transition-table's own symmetry and exhaustive testing, its
 * result carries no branch to act on).
 *
 * Crash recovery, reasoned about explicitly rather than assumed: every step
 * is idempotent, so a retried `delete` after a crash between any two steps
 * always completes correctly with no double-effect —
 * `stopAndRemoveAllSessionsUnderCwd` finds zero sessions and succeeds
 * trivially once the session is already gone; `removeAgentDirectory`
 * succeeds trivially (`force: true`) once the directory is already gone;
 * only the final store write is not yet idempotent-by-inspection on its
 * own, but by the time it runs every earlier step has already completed,
 * so a retry re-executes harmless no-ops before reaching it again.
 */
export async function deleteAgent(deps: AgentActionsDeps, query: string): Promise<DeleteAgentResult> {
  const resolved = await resolveOrRefuse(deps.agentSetPath, query);
  if (!resolved.ok) return resolved;
  const { agentSet, agent } = resolved;

  decideDelete(agent.state); // unconditional; kept for the transition table's symmetry, not branched on.

  let sessionResult: Awaited<ReturnType<typeof stopAndRemoveAllSessionsUnderCwd>>;
  try {
    sessionResult = await stopAndRemoveAllSessionsUnderCwd(deps.runCommand, deps.agentDirectoryPath(agent.id));
  } catch (err) {
    return { ok: false, error: { kind: "session-lookup-failed", error: err instanceof Error ? err.message : String(err) } };
  }
  if (sessionResult.failed.length > 0) {
    return { ok: false, error: { kind: "session-cleanup-failed", failed: sessionResult.failed } };
  }

  const dirResult = await removeAgentDirectory(deps.agentsBaseDir, agent.id);
  if (!dirResult.ok) {
    return { ok: false, error: { kind: "directory-removal-failed", reason: dirResult.reason } };
  }

  const deleted = deleteAgentMutator(agentSet, agent.id);
  if (!deleted.ok) {
    // structurally unreachable: `agent` was just resolved from this exact `agentSet`.
    return { ok: false, error: { kind: "store-malformed", error: "deleteAgent refused 'not-found' for an agent just resolved from the same set" } };
  }

  const saved = await saveOrReportFailure(
    deps.agentSetPath,
    deleted.agentSet,
    "the session was stopped and removed and the directory was deleted"
  );
  if (!saved.ok) return saved;
  return { ok: true, outcome: { kind: "deleted" } };
}
