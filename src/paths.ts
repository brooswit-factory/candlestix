import { homedir, tmpdir } from "node:os";
import * as xdg from "./xdg";

// The one impure seam for XDG resolution: reads real env/os values exactly
// once and hands them to the pure resolvers in xdg.ts. Kept separate so
// every path-shape decision stays unit-testable without touching
// `process.env`.
function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}

export function currentXdgInputs(): xdg.XdgInputs {
  return {
    home: homedir(),
    configHome: nonEmpty(process.env["XDG_CONFIG_HOME"]),
    stateHome: nonEmpty(process.env["XDG_STATE_HOME"]),
    runtimeDir: nonEmpty(process.env["XDG_RUNTIME_DIR"]),
    // XDG_RUNTIME_DIR is documented to be tied to the login session (gone
    // on logout/reboot, present across a daemon restart within the same
    // session) — exactly the durability this ticket asks the registry and
    // health signal to have. When it is unset, a uid-scoped subdirectory
    // of the OS tmpdir is the closest available approximation with the
    // same "not `cwd`, not `~/.config`" property; it is documented in the
    // README as a fallback with weaker guarantees (most tmpdirs are
    // reboot-cleared too, which is fine, but are not guaranteed stable
    // across every restart the way a real XDG_RUNTIME_DIR is).
    runtimeFallbackBase: `${tmpdir()}/candlestix-${process.getuid?.() ?? "nouid"}`,
  };
}

/** CNDLX-19 / R12: no longer read by anything — kept only so the startup warning can name the legacy file's full path. See xdg.ts. */
export const legacyRosterPath = (): string => xdg.legacyRosterPath(currentXdgInputs());
export const registryPath = (): string => xdg.registryPath(currentXdgInputs());
export const healthSignalPath = (): string => xdg.healthSignalPath(currentXdgInputs());
/** CNDLX-27/CNDLX-32: the ONE path the daemon and any client (the CLI) both resolve the API socket from. */
export const apiSocketPath = (): string => xdg.apiSocketPath(currentXdgInputs());
/** R16: id-keyed, id-validated. */
export const agentMcpConfigPath = (agentId: string): string => xdg.agentMcpConfigPath(currentXdgInputs(), agentId);
export const agentSetPath = (): string => xdg.agentSetPath(currentXdgInputs());
export const agentsBaseDir = (): string => xdg.agentsBaseDir(currentXdgInputs());
export const agentDirectoryPath = (agentId: string): string => xdg.agentDirectoryPath(currentXdgInputs(), agentId);
