import { describe, expect, test } from "bun:test";
import {
  resolveConfigHome,
  resolveRuntimeDir,
  resolveStateHome,
  legacyRosterPath,
  registryPath,
  healthSignalPath,
  agentMcpConfigPath,
  candlestixStateDir,
  agentSetPath,
  agentsBaseDir,
  agentDirectoryPath,
  type XdgInputs,
} from "../../src/xdg";
import { mintAgentId } from "../../src/agent-id";

const base: XdgInputs = {
  home: "/home/operator",
  configHome: undefined,
  stateHome: undefined,
  runtimeDir: undefined,
  runtimeFallbackBase: "/tmp/candlestix-1000",
};

describe("resolveConfigHome", () => {
  test("uses XDG_CONFIG_HOME when set", () => {
    expect(resolveConfigHome({ ...base, configHome: "/custom/config" })).toBe("/custom/config");
  });

  test("falls back to ~/.config when unset", () => {
    expect(resolveConfigHome(base)).toBe("/home/operator/.config");
  });

  test("treats an empty string the same as unset — a real case on the target host, not a hypothetical", () => {
    expect(resolveConfigHome({ ...base, configHome: "" })).toBe("/home/operator/.config");
  });
});

describe("resolveStateHome", () => {
  test("uses XDG_STATE_HOME when set", () => {
    expect(resolveStateHome({ ...base, stateHome: "/custom/state" })).toBe("/custom/state");
  });

  test("falls back to ~/.local/state when unset or empty", () => {
    expect(resolveStateHome(base)).toBe("/home/operator/.local/state");
    expect(resolveStateHome({ ...base, stateHome: "" })).toBe("/home/operator/.local/state");
  });
});

describe("resolveRuntimeDir", () => {
  test("uses XDG_RUNTIME_DIR when set", () => {
    expect(resolveRuntimeDir({ ...base, runtimeDir: "/run/user/1000" })).toBe("/run/user/1000");
  });

  test("falls back to the caller-provided base when unset or empty", () => {
    expect(resolveRuntimeDir(base)).toBe("/tmp/candlestix-1000");
    expect(resolveRuntimeDir({ ...base, runtimeDir: "" })).toBe("/tmp/candlestix-1000");
  });
});

describe("derived paths", () => {
  test("legacyRosterPath — CNDLX-19/R12: no longer read by anything, kept only so the startup warning can name its full path", () => {
    expect(legacyRosterPath(base)).toBe("/home/operator/.config/candlestix/roster.yaml");
    expect(legacyRosterPath({ ...base, configHome: "/xdg/config" })).toBe("/xdg/config/candlestix/roster.yaml");
  });

  test("registryPath and healthSignalPath live under the runtime dir, not config or an agent's own directory", () => {
    const inputs = { ...base, runtimeDir: "/run/user/1000" };
    expect(registryPath(inputs)).toBe("/run/user/1000/candlestix/registry.json");
    expect(healthSignalPath(inputs)).toBe("/run/user/1000/candlestix/health.json");
  });

  test("agentMcpConfigPath (R16) is scoped per agent ID, under the runtime dir — the live, honest path", () => {
    const inputs = { ...base, runtimeDir: "/run/user/1000" };
    const id = mintAgentId({ now: () => new Date(0), random: () => 0.5 });
    expect(agentMcpConfigPath(inputs, id)).toBe(`/run/user/1000/candlestix/agents/${id}/mcp.json`);
  });

  test("agentMcpConfigPath refuses a name — it is id-validated, not merely id-shaped by convention", () => {
    const inputs = { ...base, runtimeDir: "/run/user/1000" };
    expect(() => agentMcpConfigPath(inputs, "release-notes")).toThrow();
  });

  test("agentMcpConfigPath's path is a real function of its id argument — different ids give different paths", () => {
    // Guards against the function silently ignoring its argument (e.g.
    // returning a fixed path) — a test asserting `f(x) === f(x)` for a
    // fixed `x` would pass even if it did. This function never takes a
    // name at all, so "does it move on rename" isn't a question this pure
    // layer can pose; the real, non-tautological proof that RENAMING AN
    // AGENT does not move its MCP config path — an actual rename, with the
    // path re-derived and asserted equal before/after — lives in
    // `test/unit/agent-actions.test.ts`'s rename tests.
    const inputs = { ...base, runtimeDir: "/run/user/1000" };
    const idA = mintAgentId({ now: () => new Date(0), random: () => 0.5 });
    const idB = mintAgentId({ now: () => new Date(1), random: () => 0.25 });
    expect(idA).not.toBe(idB);
    expect(agentMcpConfigPath(inputs, idA)).not.toBe(agentMcpConfigPath(inputs, idB));
  });

  test("agentsBaseDir and agentDirectoryPath (S1) live under the STATE home, one level below agents.json, keyed by id", () => {
    const inputs = { ...base, stateHome: "/home/operator/.local/state" };
    expect(agentsBaseDir(inputs)).toBe("/home/operator/.local/state/candlestix/agents");
    const id = mintAgentId({ now: () => new Date(0), random: () => 0.5 });
    expect(agentDirectoryPath(inputs, id)).toBe(`/home/operator/.local/state/candlestix/agents/${id}`);
  });

  test("agents.json and agents/ cannot collide — different filesystem entries at the same parent", () => {
    const inputs = { ...base, stateHome: "/home/operator/.local/state" };
    expect(agentsBaseDir(inputs)).not.toBe(agentSetPath(inputs));
    expect(agentSetPath(inputs).startsWith(candlestixStateDir(inputs))).toBe(true);
    expect(agentsBaseDir(inputs).startsWith(candlestixStateDir(inputs))).toBe(true);
  });

  test("agentSetPath lives under the STATE home (R5), not the runtime dir and not config", () => {
    const inputs = { ...base, stateHome: "/home/operator/.local/state" };
    expect(candlestixStateDir(inputs)).toBe("/home/operator/.local/state/candlestix");
    expect(agentSetPath(inputs)).toBe("/home/operator/.local/state/candlestix/agents.json");
  });

  test("agentSetPath does not move when only the runtime dir changes — it is not under candlestixRuntimeDir", () => {
    const withRuntime = { ...base, runtimeDir: "/run/user/1000" };
    expect(agentSetPath(withRuntime)).toBe(agentSetPath(base));
  });
});
