// The durable agent set (CNDLX-22 / CNDLX-17): pure parse/serialize plus
// the invariant-enforcing mutators that a "create"/"rename"/"delete"
// action (sibling tickets, out of scope here) will call. No fs, no clock,
// no process, no network — mirrors the parse discipline of
// src/registry.ts and src/roster.ts (never throws, discriminated union,
// explicit version check, error strings that name the offending entry).
//
// What is deliberately NOT here: the lifecycle verbs themselves
// (create/on/off/rename/archive/unarchive/delete/list). `insertAgent`,
// `renameAgent` and `deleteAgent` below are the pure decision functions
// those verbs will call — "you write the function that refuses a rename
// onto a taken name; you do not write the rename action" (this ticket's
// own words). A verb also does things this module has no opinion on:
// persisting the result (agent-set-store.ts), deciding which state
// transitions are legal for which starting state, spawning/killing a
// session, moving the per-agent MCP config directory on rename (an
// already-known, explicitly out-of-scope issue — see the ticket). Turning
// an agent on/off/archived is therefore NOT a function in this module
// either: the flat `AgentLifecycleState` field is plain exported data
// (R6), and no cross-record invariant governs it the way R2 governs
// names, so there is nothing for this module to enforce there — a verb
// can build the next `AgentRecord` itself and hand it to `insertAgent`'s
// sibling-in-spirit (a full-record replace) or, once persisted via
// agent-set-store.ts, simply write the field.

import { isAgentId } from "./agent-id";
import { validateAgentNameSyntax, type AgentLifecycleState, type AgentRecord } from "./agent";

export interface AgentSet {
  version: 1;
  /** Keyed by id — the durable key for everything per this ticket. */
  agents: Record<string, AgentRecord>;
  /** R4: ids retired on delete, kept explicitly so a re-mint can never collide even under unlucky randomness. */
  retiredIds: string[];
}

export function emptyAgentSet(): AgentSet {
  return { version: 1, agents: {}, retiredIds: [] };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const LIFECYCLE_STATES: ReadonlySet<AgentLifecycleState> = new Set(["on", "off", "archived"]);

function isValidLifecycleState(value: unknown): value is AgentLifecycleState {
  return typeof value === "string" && LIFECYCLE_STATES.has(value as AgentLifecycleState);
}

function validateRecordShape(value: unknown, key: string): { ok: true; record: AgentRecord } | { ok: false; error: string } {
  if (!isPlainObject(value)) {
    return { ok: false, error: `agent set entry "${key}": must be a mapping, got ${value === null ? "null" : typeof value}` };
  }
  const id = value["id"];
  if (typeof id !== "string" || !isAgentId(id)) {
    return { ok: false, error: `agent set entry "${key}": "id" must be a validly-shaped minted id, got ${JSON.stringify(id)}` };
  }
  if (id !== key) {
    return { ok: false, error: `agent set entry "${key}": entry is keyed "${key}" but its own "id" field is "${id}" — these must match` };
  }

  const rawName = value["name"];
  let name: string | undefined;
  if (rawName !== undefined) {
    if (typeof rawName !== "string") {
      return { ok: false, error: `agent set entry "${key}": "name" must be a string when present, got ${typeof rawName}` };
    }
    const syntax = validateAgentNameSyntax(rawName);
    if (!syntax.ok) {
      return { ok: false, error: `agent set entry "${key}": "name" is invalid: ${syntax.error.message}` };
    }
    name = rawName;
  }

  const rawJob = value["job"];
  let job: string | undefined;
  if (rawJob !== undefined) {
    if (typeof rawJob !== "string") {
      return { ok: false, error: `agent set entry "${key}": "job" must be a string when present, got ${typeof rawJob}` };
    }
    job = rawJob;
  }

  const state = value["state"];
  if (!isValidLifecycleState(state)) {
    return { ok: false, error: `agent set entry "${key}": "state" must be one of "on", "off", "archived", got ${JSON.stringify(state)}` };
  }

  const createdAt = value["createdAt"];
  if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) {
    return { ok: false, error: `agent set entry "${key}": "createdAt" must be an ISO 8601 string, got ${JSON.stringify(createdAt)}` };
  }

  const record: AgentRecord = {
    id,
    ...(name !== undefined ? { name } : {}),
    ...(job !== undefined ? { job } : {}),
    state,
    createdAt,
  };
  return { ok: true, record };
}

export type ParseAgentSetResult = { ok: true; agentSet: AgentSet } | { ok: false; error: string };

/**
 * Pure parse: text in, typed result out, never throws. A malformed or
 * foreign-shaped agent set is reported as an error distinct from "no
 * agents yet" — see agent-set-store.ts for why that distinction is the
 * single most important thing in this ticket. This function alone cannot
 * make that distinction (it never sees "file missing"); it only ever
 * reports "this text, if it exists, does not parse."
 */
export function parseAgentSet(source: string): ParseAgentSetResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (err) {
    return { ok: false, error: `agent set is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!isPlainObject(parsed) || parsed["version"] !== 1 || !isPlainObject(parsed["agents"]) || !Array.isArray(parsed["retiredIds"])) {
    return {
      ok: false,
      error: `agent set does not have the expected { version: 1, agents: {...}, retiredIds: [...] } shape`,
    };
  }

  const agents: Record<string, AgentRecord> = {};
  const namesSeen = new Map<string, string>(); // name -> first id that holds it

  for (const [key, value] of Object.entries(parsed["agents"])) {
    const result = validateRecordShape(value, key);
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    if (result.record.name !== undefined) {
      const priorHolder = namesSeen.get(result.record.name);
      if (priorHolder !== undefined) {
        return {
          ok: false,
          error: `agent set has duplicate name "${result.record.name}" held by both "${priorHolder}" and "${key}" — R2 requires names to be unique across all non-deleted agents`,
        };
      }
      namesSeen.set(result.record.name, key);
    }
    agents[key] = result.record;
  }

  const retiredIds: string[] = [];
  for (const value of parsed["retiredIds"]) {
    if (typeof value !== "string" || !isAgentId(value)) {
      return { ok: false, error: `agent set has a malformed entry in "retiredIds": ${JSON.stringify(value)} is not a validly-shaped id` };
    }
    if (value in agents) {
      return { ok: false, error: `agent set lists id "${value}" as both active and retired — R4 requires these to be disjoint` };
    }
    retiredIds.push(value);
  }

  return { ok: true, agentSet: { version: 1, agents, retiredIds } };
}

export function serializeAgentSet(agentSet: AgentSet): string {
  return JSON.stringify(agentSet, null, 2) + "\n";
}

export function findAgentByName(agentSet: AgentSet, name: string): AgentRecord | undefined {
  return Object.values(agentSet.agents).find((agent) => agent.name === name);
}

export type InsertAgentError =
  | { kind: "id-already-used" }
  | { kind: "id-retired" }
  | { kind: "invalid-id" }
  | { kind: "invalid-name"; message: string }
  | { kind: "name-taken"; holder: AgentRecord; message: string };

export type InsertAgentResult = { ok: true; agentSet: AgentSet } | { ok: false; error: InsertAgentError };

/**
 * Adds a freshly-minted `record` to `agentSet`, enforcing R1 (id shape),
 * R2 (name uniqueness, if a name is given at creation) and R4 (a retired
 * id can never be reused). This is the primitive a "create" action calls
 * after minting an id and building the record; it is not the create
 * action itself (no persistence, no spawning, no job-text handling).
 */
export function insertAgent(agentSet: AgentSet, record: AgentRecord): InsertAgentResult {
  if (!isAgentId(record.id)) {
    return { ok: false, error: { kind: "invalid-id" } };
  }
  if (record.id in agentSet.agents) {
    return { ok: false, error: { kind: "id-already-used" } };
  }
  if (agentSet.retiredIds.includes(record.id)) {
    return { ok: false, error: { kind: "id-retired" } };
  }
  if (record.name !== undefined) {
    const syntax = validateAgentNameSyntax(record.name);
    if (!syntax.ok) {
      return { ok: false, error: { kind: "invalid-name", message: syntax.error.message } };
    }
    const holder = findAgentByName(agentSet, record.name);
    if (holder !== undefined) {
      return {
        ok: false,
        error: { kind: "name-taken", holder, message: `name "${record.name}" is already held by agent "${holder.id}"` },
      };
    }
  }
  return { ok: true, agentSet: { ...agentSet, agents: { ...agentSet.agents, [record.id]: record } } };
}

export type RenameAgentError =
  | { kind: "not-found" }
  | { kind: "invalid-name"; message: string }
  | { kind: "name-taken"; holder: AgentRecord; message: string };

export type RenameAgentResult = { ok: true; agentSet: AgentSet } | { ok: false; error: RenameAgentError };

/**
 * The function this ticket asks for by name: refuses a rename onto a name
 * already held by a *different* agent, naming the current holder in the
 * message (R2). Renaming onto the name the same agent already holds is a
 * no-op success, not an error. Archived agents are ordinary entries in
 * `agentSet.agents` (R2: "archived agents keep holding their name"), so
 * they are found and refused against exactly like any other agent —
 * nothing special-cases them here, which is what makes unarchive-can
 * never-collide true by construction rather than by a check someone has
 * to remember to add.
 */
export function renameAgent(agentSet: AgentSet, id: string, newName: string): RenameAgentResult {
  const current = agentSet.agents[id];
  if (current === undefined) {
    return { ok: false, error: { kind: "not-found" } };
  }
  const syntax = validateAgentNameSyntax(newName);
  if (!syntax.ok) {
    return { ok: false, error: { kind: "invalid-name", message: syntax.error.message } };
  }
  const holder = findAgentByName(agentSet, newName);
  if (holder !== undefined && holder.id !== id) {
    return {
      ok: false,
      error: { kind: "name-taken", holder, message: `name "${newName}" is already held by agent "${holder.id}"` },
    };
  }
  const updated: AgentRecord = { ...current, name: newName };
  return { ok: true, agentSet: { ...agentSet, agents: { ...agentSet.agents, [id]: updated } } };
}

export type DeleteAgentError = { kind: "not-found" };
export type DeleteAgentResult = { ok: true; agentSet: AgentSet } | { ok: false; error: DeleteAgentError };

/**
 * R4 + R2's "delete frees the name": removes the agent from the active
 * set and records its id as retired. The name is freed as a consequence
 * of removal, not by a separate step — `findAgentByName` simply stops
 * finding it once the record is gone.
 */
export function deleteAgent(agentSet: AgentSet, id: string): DeleteAgentResult {
  if (!(id in agentSet.agents)) {
    return { ok: false, error: { kind: "not-found" } };
  }
  const agents = { ...agentSet.agents };
  delete agents[id];
  return { ok: true, agentSet: { ...agentSet, agents, retiredIds: [...agentSet.retiredIds, id] } };
}
