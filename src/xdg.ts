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

/** `$XDG_CONFIG_HOME/candlestix/roster.yaml`, falling back per the resolvers above. */
export function rosterPath(inputs: XdgInputs): string {
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

export function agentMcpConfigPath(inputs: XdgInputs, agentName: string): string {
  return join(candlestixRuntimeDir(inputs), "agents", agentName, "mcp.json");
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
