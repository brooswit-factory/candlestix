import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReconcileCycle } from "../../src/supervisor";
import type { Roster } from "../../src/roster";
import { loadRegistry } from "../../src/registry-store";

function fakeHeartbeatStore() {
  const registered = new Set<string>();
  const heartbeats: string[] = [];
  return {
    registerSubject(id: string) {
      registered.add(id);
    },
    recordHeartbeat(id: string) {
      heartbeats.push(id);
    },
    registered,
    heartbeats,
  };
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "candlestix-supervisor-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("runReconcileCycle", () => {
  test("registers every roster agent, spawns a missing one, and records no heartbeat for it this cycle", async () => {
    await withTempDir(async (dir) => {
      const cwd = join(dir, "agent-cwd");
      await mkdir(cwd, { recursive: true });
      const roster: Roster = { agents: [{ name: "a", job: "do things", cwd, mcpServers: {} }] };
      const store = fakeHeartbeatStore();
      const commands: string[][] = [];

      await runReconcileCycle(roster, {
        registryPath: join(dir, "registry.json"),
        agentMcpConfigPath: (name) => join(dir, "mcp", `${name}.json`),
        runCommand: async (argv) => {
          commands.push(argv);
          if (argv[0] === "claude" && argv[1] === "agents") {
            return { exitCode: 0, stdout: "[]", stderr: "" };
          }
          return { exitCode: 0, stdout: "backgrounded · abc12345", stderr: "" };
        },
        heartbeatStore: store,
      });

      expect(store.registered.has("a")).toBe(true);
      expect(store.heartbeats).toEqual([]); // launch success is not proof of life yet
      expect(commands.some((c) => c[0] === "systemd-run")).toBe(true);
    });
  });

  test("an agent already listed and independently verified alive gets a heartbeat and a registry entry", async () => {
    await withTempDir(async (dir) => {
      const cwd = join(dir, "agent-cwd");
      await mkdir(cwd, { recursive: true });
      const roster: Roster = { agents: [{ name: "a", job: "do things", cwd, mcpServers: {} }] };
      const store = fakeHeartbeatStore();

      await runReconcileCycle(roster, {
        registryPath: join(dir, "registry.json"),
        agentMcpConfigPath: (name) => join(dir, "mcp", `${name}.json`),
        runCommand: async () => ({
          exitCode: 0,
          stdout: JSON.stringify([{ id: "abc", sessionId: "abc-full", cwd, kind: "background", startedAt: Date.now(), pid: process.pid }]),
          stderr: "",
        }),
        heartbeatStore: store,
      });

      expect(store.heartbeats).toEqual(["a"]);
      const registry = await loadRegistry(join(dir, "registry.json"));
      expect(registry.agents["a"]?.id).toBe("abc");
    });
  });

  test("a cwd that does not exist is skipped, never spawned into, and other agents are unaffected", async () => {
    await withTempDir(async (dir) => {
      const goodCwd = join(dir, "good");
      await mkdir(goodCwd, { recursive: true });
      const roster: Roster = {
        agents: [
          { name: "missing-dir", job: "x", cwd: join(dir, "does-not-exist"), mcpServers: {} },
          { name: "good", job: "x", cwd: goodCwd, mcpServers: {} },
        ],
      };
      const store = fakeHeartbeatStore();
      const spawnedFor: string[] = [];

      await runReconcileCycle(roster, {
        registryPath: join(dir, "registry.json"),
        agentMcpConfigPath: (name) => join(dir, "mcp", `${name}.json`),
        runCommand: async (argv, opts) => {
          if (argv[0] === "claude" && argv[1] === "agents") return { exitCode: 0, stdout: "[]", stderr: "" };
          spawnedFor.push(opts.cwd ?? "");
          return { exitCode: 0, stdout: "backgrounded · x", stderr: "" };
        },
        heartbeatStore: store,
      });

      expect(store.registered.has("missing-dir")).toBe(true);
      expect(store.registered.has("good")).toBe(true);
      expect(spawnedFor).toEqual([goodCwd]); // never attempted for the missing dir
    });
  });

  test("when listing background agents fails, no heartbeats are recorded for anyone this cycle — 'could not look' never reads as 'nothing there'", async () => {
    await withTempDir(async (dir) => {
      const cwd = join(dir, "agent-cwd");
      await mkdir(cwd, { recursive: true });
      const roster: Roster = { agents: [{ name: "a", job: "x", cwd, mcpServers: {} }] };
      const store = fakeHeartbeatStore();
      let spawnAttempted = false;

      await runReconcileCycle(roster, {
        registryPath: join(dir, "registry.json"),
        agentMcpConfigPath: (name) => join(dir, "mcp", `${name}.json`),
        runCommand: async (argv) => {
          if (argv[0] === "claude" && argv[1] === "agents") return { exitCode: 1, stdout: "", stderr: "not logged in" };
          spawnAttempted = true;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        heartbeatStore: store,
      });

      expect(store.registered.has("a")).toBe(true);
      expect(store.heartbeats).toEqual([]);
      expect(spawnAttempted).toBe(false); // must not guess-spawn when we can't see reality
    });
  });
});
