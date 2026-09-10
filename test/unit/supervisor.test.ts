import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReconcileCycle, type SupervisorOptions } from "../../src/supervisor";
import { loadRegistry } from "../../src/registry-store";
import { emptyAgentSet, insertAgent, type AgentSet } from "../../src/agent-set";
import { saveAgentSet } from "../../src/agent-set-store";
import { mintAgentId } from "../../src/agent-id";
import type { AgentRecord, AgentLifecycleState } from "../../src/agent";

function fakeHeartbeatStore() {
  const registered = new Set<string>();
  const heartbeats: string[] = [];
  const unregistered: string[] = [];
  return {
    registerSubject(id: string, _displayName?: string): void {
      registered.add(id);
    },
    recordHeartbeat(id: string, _at?: Date, _displayName?: string): void {
      heartbeats.push(id);
      registered.add(id);
    },
    unregisterSubject(id: string): void {
      registered.delete(id);
      unregistered.push(id);
    },
    listTrackedSubjects(): string[] {
      return [...registered];
    },
    registered,
    heartbeats,
    unregistered,
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

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return mintAgentId({ now: () => new Date(idCounter), random: () => Math.random() });
}

function record(state: AgentLifecycleState, name?: string): AgentRecord {
  return {
    id: nextId(),
    ...(name !== undefined ? { name } : {}),
    state,
    createdAt: new Date(0).toISOString(),
  };
}

async function seedAgentSet(path: string, records: AgentRecord[]): Promise<void> {
  let set: AgentSet = emptyAgentSet();
  for (const r of records) {
    const result = insertAgent(set, r);
    if (!result.ok) throw new Error(`seed failed: ${JSON.stringify(result.error)}`);
    set = result.agentSet;
  }
  await saveAgentSet(path, set);
}

function baseOptions(dir: string, store: ReturnType<typeof fakeHeartbeatStore>, overrides: Partial<SupervisorOptions> = {}): SupervisorOptions {
  return {
    agentSetPath: join(dir, "agents.json"),
    agentDirectoryPath: (id) => join(dir, "agents", id),
    agentMcpConfigPath: (id) => join(dir, "mcp", `${id}.json`),
    registryPath: join(dir, "registry.json"),
    runCommand: async () => ({ exitCode: 0, stdout: "[]", stderr: "" }),
    heartbeatStore: store,
    unexpectedSessionWarnings: new Map(),
    ...overrides,
  };
}

describe("runReconcileCycle — CNDLX-19: reads the durable agent set, never a roster", () => {
  test("an 'on' agent with no live session anywhere is registered as a heartbeat subject, spawned, and gets no heartbeat yet this cycle", async () => {
    await withTempDir(async (dir) => {
      const agent = record("on", "a");
      await seedAgentSet(join(dir, "agents.json"), [agent]);
      await mkdir(join(dir, "agents", agent.id), { recursive: true });
      const store = fakeHeartbeatStore();
      const commands: string[][] = [];

      await runReconcileCycle(
        baseOptions(dir, store, {
          runCommand: async (argv) => {
            commands.push(argv);
            if (argv[0] === "claude" && argv[1] === "agents") return { exitCode: 0, stdout: "[]", stderr: "" };
            return { exitCode: 0, stdout: "backgrounded · abc12345", stderr: "" };
          },
        })
      );

      expect(store.registered.has(agent.id)).toBe(true);
      expect(store.heartbeats).toEqual([]); // launch success is not proof of life yet
      expect(commands.some((c) => c[0] === "systemd-run")).toBe(true);
    });
  });

  test("an 'on' agent already listed and independently verified alive gets a heartbeat and an id-keyed registry entry", async () => {
    await withTempDir(async (dir) => {
      const agent = record("on", "a");
      await seedAgentSet(join(dir, "agents.json"), [agent]);
      const agentDir = join(dir, "agents", agent.id);
      await mkdir(agentDir, { recursive: true });
      const store = fakeHeartbeatStore();

      await runReconcileCycle(
        baseOptions(dir, store, {
          runCommand: async () => ({
            exitCode: 0,
            stdout: JSON.stringify([{ id: "abc", sessionId: "abc-full", cwd: agentDir, kind: "background", startedAt: Date.now(), pid: process.pid }]),
            stderr: "",
          }),
        })
      );

      expect(store.heartbeats).toEqual([agent.id]);
      const registry = await loadRegistry(join(dir, "registry.json"));
      expect(registry.agents[agent.id]?.sessionShortId).toBe("abc");
      expect(registry.agents[agent.id]?.agentName).toBe("a");
    });
  });

  test("an 'on' agent whose directory does not exist is skipped (dir-missing), never spawned into, other agents unaffected", async () => {
    await withTempDir(async (dir) => {
      const missingDirAgent = record("on", "missing-dir");
      const goodAgent = record("on", "good");
      await seedAgentSet(join(dir, "agents.json"), [missingDirAgent, goodAgent]);
      await mkdir(join(dir, "agents", goodAgent.id), { recursive: true });
      // missingDirAgent's own directory is deliberately never created.
      const store = fakeHeartbeatStore();
      const spawnedFor: string[] = [];

      await runReconcileCycle(
        baseOptions(dir, store, {
          runCommand: async (argv, opts) => {
            if (argv[0] === "claude" && argv[1] === "agents") return { exitCode: 0, stdout: "[]", stderr: "" };
            spawnedFor.push(opts.cwd ?? "");
            return { exitCode: 0, stdout: "backgrounded · x", stderr: "" };
          },
        })
      );

      expect(store.registered.has(missingDirAgent.id)).toBe(true);
      expect(store.registered.has(goodAgent.id)).toBe(true);
      expect(spawnedFor).toEqual([join(dir, "agents", goodAgent.id)]); // never attempted for the missing dir
    });
  });

  test("when listing background agents fails, no heartbeats are recorded for anyone this cycle", async () => {
    await withTempDir(async (dir) => {
      const agent = record("on", "a");
      await seedAgentSet(join(dir, "agents.json"), [agent]);
      await mkdir(join(dir, "agents", agent.id), { recursive: true });
      const store = fakeHeartbeatStore();
      let spawnAttempted = false;

      await runReconcileCycle(
        baseOptions(dir, store, {
          runCommand: async (argv) => {
            if (argv[0] === "claude" && argv[1] === "agents") return { exitCode: 1, stdout: "", stderr: "not logged in" };
            spawnAttempted = true;
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        })
      );

      expect(store.registered.has(agent.id)).toBe(true);
      expect(store.heartbeats).toEqual([]);
      expect(spawnAttempted).toBe(false); // must not guess-spawn when we can't see reality
    });
  });

  describe("CNDLX-19 T1: off/archived agents are never spawned, by any path", () => {
    for (const state of ["off", "archived"] as const) {
      test(`a(n) ${state} agent with no live session anywhere is never spawned, even though its directory exists`, async () => {
        await withTempDir(async (dir) => {
          const agent = record(state, "a");
          await seedAgentSet(join(dir, "agents.json"), [agent]);
          await mkdir(join(dir, "agents", agent.id), { recursive: true });
          const store = fakeHeartbeatStore();
          let spawnAttempted = false;

          await runReconcileCycle(
            baseOptions(dir, store, {
              runCommand: async (argv) => {
                if (argv[0] === "claude" && argv[1] === "agents") return { exitCode: 0, stdout: "[]", stderr: "" };
                spawnAttempted = true;
                return { exitCode: 0, stdout: "backgrounded · x", stderr: "" };
              },
            })
          );

          expect(spawnAttempted).toBe(false);
        });
      });
    }
  });

  test("CNDLX-19 T3: only 'on' agents are heartbeat subjects — off/archived never get registered", async () => {
    await withTempDir(async (dir) => {
      const onAgent = record("on", "keeper");
      const offAgent = record("off", "sleeper");
      const archivedAgent = record("archived", "shelved");
      await seedAgentSet(join(dir, "agents.json"), [onAgent, offAgent, archivedAgent]);
      await mkdir(join(dir, "agents", onAgent.id), { recursive: true });
      const store = fakeHeartbeatStore();

      await runReconcileCycle(baseOptions(dir, store));

      expect(store.registered.has(onAgent.id)).toBe(true);
      expect(store.registered.has(offAgent.id)).toBe(false);
      expect(store.registered.has(archivedAgent.id)).toBe(false);
    });
  });

  test("CNDLX-19 T3: an agent that WAS 'on' and is now 'off' stops being a heartbeat subject across a cycle", async () => {
    await withTempDir(async (dir) => {
      const agent = record("off", "was-on");
      await seedAgentSet(join(dir, "agents.json"), [agent]);
      const store = fakeHeartbeatStore();
      // Simulate: this store already tracked it from a PRIOR cycle when it was "on".
      store.registerSubject(agent.id, "was-on");
      expect(store.registered.has(agent.id)).toBe(true);

      await runReconcileCycle(baseOptions(dir, store));

      expect(store.registered.has(agent.id)).toBe(false);
      expect(store.unregistered).toContain(agent.id);
    });
  });

  describe("CNDLX-19 T2: off/archived with a stray live session under its directory — report only, never stop it", () => {
    for (const state of ["off", "archived"] as const) {
      test(`a(n) ${state} agent with a live session under its directory: no stop/rm command is ever issued`, async () => {
        await withTempDir(async (dir) => {
          const agent = record(state, "stray");
          await seedAgentSet(join(dir, "agents.json"), [agent]);
          const agentDir = join(dir, "agents", agent.id);
          await mkdir(agentDir, { recursive: true });
          const store = fakeHeartbeatStore();
          const commandsIssued: string[][] = [];

          await runReconcileCycle(
            baseOptions(dir, store, {
              runCommand: async (argv) => {
                commandsIssued.push(argv);
                if (argv[0] === "claude" && argv[1] === "agents") {
                  return {
                    exitCode: 0,
                    stdout: JSON.stringify([{ id: "stray1", sessionId: "stray1-full", cwd: agentDir, kind: "background", startedAt: Date.now(), pid: process.pid }]),
                    stderr: "",
                  };
                }
                return { exitCode: 0, stdout: "", stderr: "" };
              },
            })
          );

          expect(commandsIssued.some((c) => c[0] === "claude" && (c[1] === "stop" || c[1] === "rm"))).toBe(false);
          expect(commandsIssued.some((c) => c[0] === "systemd-run")).toBe(false); // never spawned either
        });
      });

      test(`the ${state}-with-stray-session warning does not repeat every cycle for an unchanged condition (T2's no-repeat rule)`, async () => {
        await withTempDir(async (dir) => {
          const agent = record(state, "stray");
          await seedAgentSet(join(dir, "agents.json"), [agent]);
          const agentDir = join(dir, "agents", agent.id);
          await mkdir(agentDir, { recursive: true });
          const store = fakeHeartbeatStore();
          const warnings = new Map<string, string>();
          const runCommand = async (argv: string[]) => {
            if (argv[0] === "claude" && argv[1] === "agents") {
              return {
                exitCode: 0,
                stdout: JSON.stringify([{ id: "stray1", sessionId: "stray1-full", cwd: agentDir, kind: "background", startedAt: Date.now(), pid: process.pid }]),
                stderr: "",
              };
            }
            return { exitCode: 0, stdout: "", stderr: "" };
          };

          await runReconcileCycle(baseOptions(dir, store, { runCommand, unexpectedSessionWarnings: warnings }));
          expect(warnings.get(agent.id)).toBe("stray1");

          // A second cycle with the SAME unresolved condition must not
          // reset or duplicate the suppression entry — this test only
          // proves the state persists across cycles when the caller
          // threads the same Map through, which src/index.ts does.
          await runReconcileCycle(baseOptions(dir, store, { runCommand, unexpectedSessionWarnings: warnings }));
          expect(warnings.get(agent.id)).toBe("stray1");
        });
      });
    }
  });

  test("CNDLX-19 T1: a malformed agent set skips the ENTIRE cycle — heartbeat store and registry both untouched", async () => {
    await withTempDir(async (dir) => {
      const agentSetPath = join(dir, "agents.json");
      await mkdir(dir, { recursive: true });
      await writeFile(agentSetPath, "{not json at all", "utf8");
      const store = fakeHeartbeatStore();
      let anyCommandRan = false;

      await runReconcileCycle(
        baseOptions(dir, store, {
          agentSetPath,
          runCommand: async () => {
            anyCommandRan = true;
            return { exitCode: 0, stdout: "[]", stderr: "" };
          },
        })
      );

      expect(anyCommandRan).toBe(false);
      expect(store.registered.size).toBe(0);
      const { pathExists } = await import("../../src/registry-store");
      expect(await pathExists(join(dir, "registry.json"))).toBe(false);
    });
  });

  test("a missing agent set (first run) is a success — zero agents, nothing spawned, registry still written", async () => {
    await withTempDir(async (dir) => {
      const store = fakeHeartbeatStore();
      await runReconcileCycle(baseOptions(dir, store, { agentSetPath: join(dir, "does-not-exist.json") }));
      expect(store.registered.size).toBe(0);
      const registry = await loadRegistry(join(dir, "registry.json"));
      expect(Object.keys(registry.agents)).toEqual([]);
    });
  });
});
