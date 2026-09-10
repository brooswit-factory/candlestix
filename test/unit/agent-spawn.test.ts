import { describe, expect, test } from "bun:test";
import { spawnDaemonAgent } from "../../src/agent-spawn";
import { mintAgentId } from "../../src/agent-id";

const id = mintAgentId({ now: () => new Date(1_726_000_000_000), random: () => 0.25 });
const cwd = "/state/candlestix/agents/" + id;
const mcpConfigPath = "/run/candlestix/agents/" + id + "/mcp.json";

describe("spawnDaemonAgent — R11 + S6", () => {
  test("a blank agent (no job) omits --append-system-prompt entirely, never an empty string", async () => {
    const commands: string[][] = [];
    const result = await spawnDaemonAgent({ id }, cwd, mcpConfigPath, {
      writeMcpConfig: async () => {},
      runCommand: async (argv, opts) => {
        commands.push(argv);
        expect(opts.cwd).toBe(cwd);
        return { exitCode: 0, stdout: "backgrounded · abc12345 (idle)", stderr: "" };
      },
    });
    expect(result).toEqual({ ok: true });
    expect(commands).toHaveLength(1);
    const argv = commands[0]!;
    expect(argv).not.toContain("--append-system-prompt");
    expect(argv).toContain("claude");
    expect(argv).toContain("--bg");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv).toContain("--mcp-config");
    expect(argv).toContain(mcpConfigPath);
  });

  test("a job present includes --append-system-prompt <job> as its own argv element", async () => {
    const commands: string[][] = [];
    await spawnDaemonAgent({ id, job: "watch PRs" }, cwd, mcpConfigPath, {
      writeMcpConfig: async () => {},
      runCommand: async (argv) => {
        commands.push(argv);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const argv = commands[0]!;
    const flagIndex = argv.indexOf("--append-system-prompt");
    expect(flagIndex).toBeGreaterThan(-1);
    expect(argv[flagIndex + 1]).toBe("watch PRs");
  });

  test("writes an EMPTY mcpServers object at the supplied path (S6) by default", async () => {
    const writes: Array<{ path: string; contents: string }> = [];
    // Exercise the real default writer via a temp file, not a fake, so the
    // actual on-disk shape is asserted rather than assumed.
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "candlestix-agent-spawn-"));
    try {
      const path = join(dir, "agents", id, "mcp.json");
      const result = await spawnDaemonAgent({ id }, cwd, path, {
        runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      });
      expect(result).toEqual({ ok: true });
      const contents = await readFile(path, "utf8");
      writes.push({ path, contents });
      expect(JSON.parse(contents)).toEqual({ mcpServers: {} });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    expect(writes).toHaveLength(1);
  });

  test("every launch is wrapped in its own systemd-run --user --scope with --expand-environment=no (R7)", async () => {
    const commands: string[][] = [];
    await spawnDaemonAgent({ id }, cwd, mcpConfigPath, {
      writeMcpConfig: async () => {},
      runCommand: async (argv) => {
        commands.push(argv);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const argv = commands[0]!;
    expect(argv[0]).toBe("systemd-run");
    expect(argv).toContain("--user");
    expect(argv).toContain("--scope");
    expect(argv).toContain("--expand-environment=no");
    expect(argv).toContain("--collect");
  });

  test("a job containing shell metacharacters travels unchanged, as its own argv element", async () => {
    const weirdJob = 'line one\nline two with $HOME and `backtick` and "quotes"';
    const commands: string[][] = [];
    await spawnDaemonAgent({ id, job: weirdJob }, cwd, mcpConfigPath, {
      writeMcpConfig: async () => {},
      runCommand: async (argv) => {
        commands.push(argv);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(commands[0]).toContain(weirdJob);
  });

  test("a non-zero exit from the launcher is a spawn failure with the real stderr surfaced", async () => {
    const result = await spawnDaemonAgent({ id }, cwd, mcpConfigPath, {
      writeMcpConfig: async () => {},
      runCommand: async () => ({ exitCode: 1, stdout: "", stderr: "systemd-run: command not found" }),
    });
    expect(result).toEqual({ ok: false, error: expect.stringContaining("systemd-run: command not found") });
  });

  test("a failure writing the MCP config is reported and never attempts to launch", async () => {
    let launched = false;
    const result = await spawnDaemonAgent({ id }, cwd, mcpConfigPath, {
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

  test("a thrown launch (e.g. a timeout) is a spawn failure, not an unhandled rejection", async () => {
    const result = await spawnDaemonAgent({ id }, cwd, mcpConfigPath, {
      writeMcpConfig: async () => {},
      runCommand: async () => {
        throw new Error("command timed out after 20000ms");
      },
    });
    expect(result).toEqual({ ok: false, error: expect.stringContaining("timed out") });
  });
});
