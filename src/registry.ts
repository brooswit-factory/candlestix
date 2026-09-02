// Durable registry: roster agent name -> the background Claude session
// candlestix believes backs it. Written under XDG_RUNTIME_DIR (see
// src/xdg.ts) so it survives a daemon restart but not a reboot — matching
// the ticket's requirement exactly, since the sessions themselves do not
// survive a reboot either.
//
// IMPORTANT: this registry is bookkeeping and an operator-visible audit
// trail, NOT the source of truth for liveness. `claude agents --json`,
// cross-checked against a live `kill(pid, 0)` at read time (see proc.ts and
// reconcile.ts), is the source of truth every cycle. If this file is lost
// or corrupted, `reconcile.ts`'s adopt-by-cwd fallback rebuilds the mapping
// from `claude`'s own live state on the very next cycle — the registry is
// safely reconstructable, by construction, not by convention.

export interface RegistryEntry {
  name: string;
  /** Short id: what `claude attach|logs|stop` take. */
  id: string;
  /** Full session UUID, as reported by `claude agents --json`. */
  sessionId: string;
  /** The roster `cwd` this entry was last confirmed to be running under. */
  cwd: string;
  /** ISO 8601. When this entry was first recorded (adoption or spawn). */
  spawnedAt: string;
}

export interface Registry {
  version: 1;
  agents: Record<string, RegistryEntry>;
}

export function emptyRegistry(): Registry {
  return { version: 1, agents: {} };
}

export function upsertRegistryEntry(registry: Registry, entry: RegistryEntry): Registry {
  return { ...registry, agents: { ...registry.agents, [entry.name]: entry } };
}

export function removeRegistryEntry(registry: Registry, name: string): Registry {
  if (!(name in registry.agents)) return registry;
  const agents = { ...registry.agents };
  delete agents[name];
  return { ...registry, agents };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidEntry(value: unknown): value is RegistryEntry {
  return (
    isPlainObject(value) &&
    typeof value["name"] === "string" &&
    typeof value["id"] === "string" &&
    typeof value["sessionId"] === "string" &&
    typeof value["cwd"] === "string" &&
    typeof value["spawnedAt"] === "string"
  );
}

/**
 * Pure parse: text in, typed result out, never throws. Mirrors
 * `parseRoster`'s discipline. A malformed or foreign-shaped registry file
 * is reported as an error rather than silently coerced to empty — silently
 * returning `emptyRegistry()` here would be indistinguishable from "no
 * agents have ever been spawned", which risks the caller spawning
 * duplicates for agents that are, in fact, already running. The caller
 * (loadRegistry) treats a parse error as "we don't know", not as "empty".
 */
export function parseRegistry(source: string): { ok: true; registry: Registry } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (err) {
    return { ok: false, error: `registry is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!isPlainObject(parsed) || parsed["version"] !== 1 || !isPlainObject(parsed["agents"])) {
    return { ok: false, error: `registry does not have the expected { version: 1, agents: {...} } shape` };
  }

  const agents: Record<string, RegistryEntry> = {};
  for (const [name, entry] of Object.entries(parsed["agents"])) {
    if (!isValidEntry(entry)) {
      return { ok: false, error: `registry entry "${name}" is malformed` };
    }
    agents[name] = entry;
  }

  return { ok: true, registry: { version: 1, agents } };
}

export function serializeRegistry(registry: Registry): string {
  return JSON.stringify(registry, null, 2) + "\n";
}
