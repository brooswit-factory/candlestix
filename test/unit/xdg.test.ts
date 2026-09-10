import { describe, expect, test } from "bun:test";
import { resolveConfigHome, resolveRuntimeDir, resolveStateHome, rosterPath, registryPath, healthSignalPath, agentMcpConfigPath, candlestixStateDir, agentSetPath, type XdgInputs } from "../../src/xdg";

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
  test("rosterPath", () => {
    expect(rosterPath(base)).toBe("/home/operator/.config/candlestix/roster.yaml");
    expect(rosterPath({ ...base, configHome: "/xdg/config" })).toBe("/xdg/config/candlestix/roster.yaml");
  });

  test("registryPath and healthSignalPath live under the runtime dir, not config or a roster cwd", () => {
    const inputs = { ...base, runtimeDir: "/run/user/1000" };
    expect(registryPath(inputs)).toBe("/run/user/1000/candlestix/registry.json");
    expect(healthSignalPath(inputs)).toBe("/run/user/1000/candlestix/health.json");
  });

  test("agentMcpConfigPath is scoped per agent name, under the runtime dir", () => {
    const inputs = { ...base, runtimeDir: "/run/user/1000" };
    expect(agentMcpConfigPath(inputs, "release-notes")).toBe("/run/user/1000/candlestix/agents/release-notes/mcp.json");
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
