// Ephemeral session registry: candlestix's own bookkeeping of
// `agent id -> the live claude session candlestix believes backs it`.
// Written under XDG_RUNTIME_DIR (see src/xdg.ts) so it survives a daemon
// restart but not a reboot — the sessions themselves do not survive a
// reboot either, so this is the right lifetime, not a shortfall.
//
// IMPORTANT: this registry is bookkeeping and an operator-visible audit
// trail, NOT the source of truth for liveness. `claude agents --json`,
// cross-checked against a live `kill(pid, 0)` at read time (see proc.ts and
// reconcile.ts), is the source of truth every cycle. If this file is lost
// or corrupted, `reconcile.ts`'s adopt-by-directory fallback rebuilds the
// mapping from `claude`'s own live state on the very next cycle — the
// registry is safely reconstructable, by construction, not by convention.
//
// CNDLX-19 T4 / H1: keyed by the agent's DURABLE id, never by its mutable
// name. The pre-CNDLX-19 registry (version 1) was keyed by a roster agent's
// name; that roster, and the name-keyed registry shape that went with it,
// are retired — see agent-set.ts / agent-actions.ts for the durable agent
// set this now reads against, and registry-store.ts for how a version-1
// file on disk is recognised as superseded (not "malformed") and discarded.
// A name is still carried, but only ever as `agentName` — a DISPLAY field,
// never a key and never consulted by any match/lookup in this module or in
// reconcile.ts.

export interface RegistryEntry {
  /** The agent's durable, minted id (agent-id.ts). The key this entry is stored under — see `Registry.agents` below. */
  agentId: string;
  /** Display only — never a key, never matched against. Absent for a blank/nameless agent. */
  agentName?: string;
  /** Short id: what `claude attach|logs|stop` take. */
  sessionShortId: string;
  /** Full session UUID, as reported by `claude agents --json`. */
  sessionId: string;
  /** The directory this entry was last confirmed running under. */
  cwd: string;
  /** ISO 8601. When this entry was first recorded (adoption or spawn). */
  spawnedAt: string;
}

export interface Registry {
  version: 2;
  /** Keyed by the agent's durable id (T4) — never by name. */
  agents: Record<string, RegistryEntry>;
}

export function emptyRegistry(): Registry {
  return { version: 2, agents: {} };
}

export function upsertRegistryEntry(registry: Registry, entry: RegistryEntry): Registry {
  return { ...registry, agents: { ...registry.agents, [entry.agentId]: entry } };
}

export function removeRegistryEntry(registry: Registry, agentId: string): Registry {
  if (!(agentId in registry.agents)) return registry;
  const agents = { ...registry.agents };
  delete agents[agentId];
  return { ...registry, agents };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidEntry(value: unknown, key: string): value is RegistryEntry {
  return (
    isPlainObject(value) &&
    typeof value["agentId"] === "string" &&
    value["agentId"] === key &&
    (value["agentName"] === undefined || typeof value["agentName"] === "string") &&
    typeof value["sessionShortId"] === "string" &&
    typeof value["sessionId"] === "string" &&
    typeof value["cwd"] === "string" &&
    typeof value["spawnedAt"] === "string"
  );
}

/**
 * The exact shape a pre-CNDLX-19, roster-driven, name-keyed registry entry
 * had (see this repo's history: `{ name, id, sessionId, cwd, spawnedAt }`,
 * `id` there meaning the session short id). Used only to distinguish a
 * genuinely-legacy file from a genuinely-malformed one — see
 * `parseRegistry` below and T4's own instruction that the two must not be
 * reported with the same message.
 */
function isLegacyV1Entry(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    typeof value["name"] === "string" &&
    typeof value["id"] === "string" &&
    typeof value["sessionId"] === "string" &&
    typeof value["cwd"] === "string" &&
    typeof value["spawnedAt"] === "string"
  );
}

export type ParseRegistryResult =
  | { ok: true; registry: Registry }
  /** Recognisably the pre-CNDLX-19 shape (version 1, name-keyed entries) — superseded, not corrupt. See T4. */
  | { ok: false; kind: "legacy" }
  | { ok: false; kind: "malformed"; error: string };

/**
 * Pure parse: text in, typed result out, never throws. A malformed or
 * foreign-shaped registry file is reported as an error rather than
 * silently coerced to empty — silently returning `emptyRegistry()` here
 * would be indistinguishable from "no agents have ever been spawned",
 * which risks the caller spawning duplicates for agents that are, in fact,
 * already running. The caller (loadRegistry) treats "malformed" or
 * "legacy" as "we don't know / this is stale", not as "empty" without
 * comment.
 */
export function parseRegistry(source: string): ParseRegistryResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (err) {
    return { ok: false, kind: "malformed", error: `registry is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!isPlainObject(parsed) || !isPlainObject(parsed["agents"])) {
    return {
      ok: false,
      kind: "malformed",
      error: `registry does not have the expected { version, agents: {...} } shape`,
    };
  }

  if (parsed["version"] === 1) {
    const entries = Object.values(parsed["agents"]);
    const looksLegacy = entries.every(isLegacyV1Entry);
    if (looksLegacy) {
      return { ok: false, kind: "legacy" };
    }
    return {
      ok: false,
      kind: "malformed",
      error: `registry is version 1 but its entries do not match the known pre-CNDLX-19 shape — this is genuinely corrupt, not merely superseded`,
    };
  }

  if (parsed["version"] !== 2) {
    return { ok: false, kind: "malformed", error: `registry has unknown version ${JSON.stringify(parsed["version"])}, expected 2` };
  }

  const agents: Record<string, RegistryEntry> = {};
  for (const [key, entry] of Object.entries(parsed["agents"])) {
    if (!isValidEntry(entry, key)) {
      return { ok: false, kind: "malformed", error: `registry entry "${key}" is malformed` };
    }
    agents[key] = entry;
  }

  return { ok: true, registry: { version: 2, agents } };
}

export function serializeRegistry(registry: Registry): string {
  return JSON.stringify(registry, null, 2) + "\n";
}
