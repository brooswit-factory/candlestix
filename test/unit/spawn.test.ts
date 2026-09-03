import { describe, expect, test } from "bun:test";
import { spawnBackgroundAgent } from "../../src/spawn";
import type { RosterAgent } from "../../src/roster";

const agent: RosterAgent = {
  name: "release-notes",
  job: "watch PRs and draft release notes",
  cwd: "/home/operator/code/candlestix",
  mcpServers: { github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] } },
};

describe("spawnBackgroundAgent", () => {
  test("writes the mcp config, then launches via systemd-run --scope wrapping claude --bg, run under the roster cwd", async () => {
    const writes: Array<{ path: string; mcpServers: unknown }> = [];
    const commands: Array<{ argv: string[]; opts: { cwd?: string; timeoutMs: number } }> = [];

    const result = await spawnBackgroundAgent(agent, "/run/user/1000/candlestix/agents/release-notes/mcp.json", {
      writeMcpConfig: async (path, mcpServers) => {
        writes.push({ path, mcpServers });
      },
      runCommand: async (argv, opts) => {
        commands.push({ argv, opts });
        return { exitCode: 0, stdout: "backgrounded · abc12345 (idle)", stderr: "" };
      },
    });

    expect(result).toEqual({ ok: true });
    expect(writes).toEqual([{ path: "/run/user/1000/candlestix/agents/release-notes/mcp.json", mcpServers: agent.mcpServers }]);

    expect(commands).toHaveLength(1);
    const first = commands[0];
    if (!first) throw new Error("expected one command");
    const { argv, opts } = first;
    expect(argv![0]).toBe("systemd-run");
    expect(argv).toContain("--user");
    expect(argv).toContain("--scope");
    expect(argv).toContain("--expand-environment=no");
    expect(argv).toContain("--collect");
    expect(argv).toContain("claude");
    expect(argv).toContain("--bg");
    // The job text travels as its own argv element — never interpolated
    // into a shell string — so arbitrary content (quotes, `$`, backticks,
    // newlines) needs no escaping and cannot break the command.
    expect(argv).toContain(agent.job);
    expect(argv).toContain("--strict-mcp-config");
    expect(argv).toContain("--mcp-config");
    expect(argv).toContain("/run/user/1000/candlestix/agents/release-notes/mcp.json");
    expect(opts.cwd).toBe(agent.cwd);
  });

  test("a job description containing shell metacharacters is passed through unchanged", async () => {
    const weirdAgent: RosterAgent = { ...agent, job: 'line one\nline two with $HOME and `backtick` and "quotes"' };
    const commands: string[][] = [];
    await spawnBackgroundAgent(weirdAgent, "/tmp/mcp.json", {
      writeMcpConfig: async () => {},
      runCommand: async (argv) => {
        commands.push(argv);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(commands[0]).toContain(weirdAgent.job);
  });

  test("a non-zero exit from the launcher is a spawn failure, with the real stderr surfaced", async () => {
    const result = await spawnBackgroundAgent(agent, "/tmp/mcp.json", {
      writeMcpConfig: async () => {},
      runCommand: async () => ({ exitCode: 1, stdout: "", stderr: "systemd-run: command not found" }),
    });
    expect(result).toEqual({ ok: false, error: expect.stringContaining("systemd-run: command not found") });
  });

  test("a thrown launch (e.g. a timeout) is a spawn failure, not an unhandled rejection", async () => {
    const result = await spawnBackgroundAgent(agent, "/tmp/mcp.json", {
      writeMcpConfig: async () => {},
      runCommand: async () => {
        throw new Error("command timed out after 20000ms");
      },
    });
    expect(result).toEqual({ ok: false, error: expect.stringContaining("timed out") });
  });

  test("a failure writing the MCP config is reported and never attempts to launch", async () => {
    let launched = false;
    const result = await spawnBackgroundAgent(agent, "/tmp/mcp.json", {
      writeMcpConfig: async () => {
        throw new Error("EACCES");
      },
      runCommand: async () => {
        launched = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(result.ok).toBe(false);
    expect(launched).toBe(false);
  });
});
