// Pure XDG Base Directory resolution. No env read, no filesystem, no
// process access — every input (home dir, the three XDG vars, and a
// fallback base for XDG_RUNTIME_DIR when it is unset) is a parameter, the
// same clock/I/O-passed-in discipline `log.ts` and `staleness.ts` already
// use. An impure caller (src/paths.ts) reads `process.env` / `os.homedir`
// / `os.tmpdir` once and passes them in here.
//
// Empty-string handling: an XDG var set to "" is treated exactly like it
// being unset, per the XDG Base Directory spec and this ticket's explicit
// callout that an empty-string `XDG_CONFIG_HOME` is a real case on the
// target host's class of systems, not a hypothetical.
//
// CNDLX-23 / R16: `agentMcpConfigPath` below USED TO take an agent NAME and
// build a path under it — verified still true at that ticket's own commit,
// with exactly one production call site (the roster-driven supervisor spawn
// path). That collided head-on with "a rename never moves an agent's
// directory or its other per-agent state" once names become mutable
// labels. Re-keyed to take a minted id instead, id-validated so a caller
// cannot silently pass a name by accident.
//
// CNDLX-19 / T6: the roster, the roster-driven spawn path, and the
// name-keyed per-agent MCP config path CNDLX-18 quarantined for exactly
// this retirement (`legacyRosterMcpConfigPath`) are all gone — deleted, not
// kept. `rosterPath` below is the ONE exception, per the ticket's own
// instruction: R12's startup warning must name the legacy file's full
// path, so something must still compute it. Renamed to `legacyRosterPath`
// so a later reader cannot mistake it for a live input — it is referenced
// from exactly one place (src/index.ts's one-time startup check) and is
// never used to read the file it points at.

import { isAgentId } from "./agent-id";

export interface XdgInputs {
  home: string;
  configHome: string | undefined;
  stateHome: string | undefined;
  runtimeDir: string | undefined;
  /** Used only when `runtimeDir` is unset/empty. Caller's job to make this stable across restarts of the same host/user. */
  runtimeFallbackBase: string;
}

function orFallback(value: string | undefined, fallback: string): string {
  return value !== undefined && value.length > 0 ? value : fallback;
}

function join(...parts: string[]): string {
  return parts
    .map((p, i) => (i === 0 ? p.replace(/\/+$/, "") : p.replace(/^\/+|\/+$/g, "")))
    .filter((p) => p.length > 0)
    .join("/");
}

export function resolveConfigHome(inputs: XdgInputs): string {
  return orFallback(inputs.configHome, join(inputs.home, ".config"));
}

export function resolveStateHome(inputs: XdgInputs): string {
  return orFallback(inputs.stateHome, join(inputs.home, ".local", "state"));
}

export function resolveRuntimeDir(inputs: XdgInputs): string {
  return orFallback(inputs.runtimeDir, inputs.runtimeFallbackBase);
}

/**
 * `$XDG_CONFIG_HOME/candlestix/roster.yaml`, falling back per the
 * resolvers above. CNDLX-19 / R12 / T6: this file is NO LONGER READ by any
 * code path — the roster it named is retired. This function survives
 * solely so `src/index.ts`'s one-time startup check can name the legacy
 * file's full path in its warning when one is found on disk; it is not a
 * live input to anything.
 */
export function legacyRosterPath(inputs: XdgInputs): string {
  return join(resolveConfigHome(inputs), "candlestix", "roster.yaml");
}

/**
 * Candlestix's own generated, ephemeral files: the durable-across-restart
 * registry, the health signal, and per-agent MCP config files. Deliberately
 * under XDG_RUNTIME_DIR, never under a roster entry's own `cwd` — that cwd
 * is the operator's working directory, not candlestix's.
 */
export function candlestixRuntimeDir(inputs: XdgInputs): string {
  return join(resolveRuntimeDir(inputs), "candlestix");
}

export function registryPath(inputs: XdgInputs): string {
  return join(candlestixRuntimeDir(inputs), "registry.json");
}

export function healthSignalPath(inputs: XdgInputs): string {
  return join(candlestixRuntimeDir(inputs), "health.json");
}

/**
 * CNDLX-27/CNDLX-32: the daemon API's Unix domain socket. The ONE function
 * both the daemon (which binds it) and any client (the CLI, CNDLX-28) call
 * to find it, so the two surfaces cannot disagree about where the socket
 * is — same discipline as `agentMcpConfigPath`/`agentDirectoryPath` above.
 * Lives under the runtime dir, not the state dir: the socket is
 * candlestix's own ephemeral entry point for THIS running daemon process,
 * not durable state — a dead daemon's stale socket file is meaningless
 * without a live process behind it (see api/server.ts's startup check),
 * exactly like the registry and health signal already here.
 */
export function apiSocketPath(inputs: XdgInputs): string {
  return join(candlestixRuntimeDir(inputs), "api.sock");
}

/**
 * R16: the id-keyed, id-validated per-agent MCP config path for a
 * daemon-created agent. Still lives under the runtime dir (an MCP config is
 * regenerated at spawn, not durable state — the runtime/durable split
 * itself was correct; only the key was wrong). Throws on a structurally
 * invalid id rather than silently building a path for garbage input: a
 * caller passing something that is not a minted id here is a programming
 * error, not a user-facing case (contrast with the store-facing refusals in
 * agent-lifecycle.ts / agent-actions.ts, which ARE user-facing).
 */
export function agentMcpConfigPath(inputs: XdgInputs, agentId: string): string {
  if (!isAgentId(agentId)) {
    throw new Error(`agentMcpConfigPath: "${agentId}" is not a structurally valid minted agent id`);
  }
  return join(candlestixRuntimeDir(inputs), "agents", agentId, "mcp.json");
}

/**
 * `$XDG_STATE_HOME/candlestix` — home for the durable agent set (CNDLX-22),
 * deliberately separate from `candlestixRuntimeDir` above. The agent set
 * is the thing only candlestix knows and must survive a reboot; the
 * runtime dir's contents (registry, health signal, MCP config) either are
 * reconstructable from `claude`'s own state or are meant to die with the
 * session. Merging them would drag the durable half down to the ephemeral
 * half's lifetime — see this ticket's R5.
 *
 * State home over data home: the XDG spec frames state home as "current
 * state of the application that can be reused on a restart" — which is
 * exactly what the agent set is (which agents exist, named what, toggled
 * how), not user-authored content the operator would think to back up or
 * migrate independently of candlestix itself. `resolveStateHome` already
 * existed in this module, exported and unit-tested, with no production
 * path consuming it before this ticket — this is that path.
 */
export function candlestixStateDir(inputs: XdgInputs): string {
  return join(resolveStateHome(inputs), "candlestix");
}

export function agentSetPath(inputs: XdgInputs): string {
  return join(candlestixStateDir(inputs), "agents.json");
}

/**
 * S1: `$XDG_STATE_HOME/candlestix/agents/` — the base directory candlestix
 * creates and owns for every daemon-created agent's own directory, one
 * level below the durable store (`agentSetPath` above) rather than off on
 * its own. Same base CNDLX-17 chose for `agents.json`, for the same three
 * reasons (recorded in full in this story's doc, brief version): (a) the
 * directory and its conversation must survive a reboot, which the runtime
 * dir is documented not to do; (b) it keeps candlestix's whole durable
 * footprint one tree an operator can back up or inspect as a unit; (c)
 * state home, not data home — this is candlestix-owned state derived from
 * a minted id, not user-authored content an operator would migrate
 * independently.
 *
 * No name collision with the `agents.json` FILE at the same directory
 * level: `agents.json` and `agents/` are different filesystem entries (a
 * file and a directory cannot share a name in the same parent), and this is
 * asserted by test, not merely assumed.
 */
export function agentsBaseDir(inputs: XdgInputs): string {
  return join(candlestixStateDir(inputs), "agents");
}

/**
 * S1's per-agent directory. Pure path join only — does NOT validate `id`
 * (unlike `agentMcpConfigPath` above). The safety-critical guard belongs at
 * the removal call site (see `guardAgentDirectoryRemoval` in
 * agent-directory.ts), which independently re-derives and checks this same
 * path rather than trusting this function's caller to have validated
 * anything first — S3 asks for a guard that is "a test, not a comment", and
 * a throw buried in a path-builder used for both create AND delete would
 * make that guard easy to satisfy by accident rather than by construction.
 */
export function agentDirectoryPath(inputs: XdgInputs, id: string): string {
  return join(agentsBaseDir(inputs), id);
}
