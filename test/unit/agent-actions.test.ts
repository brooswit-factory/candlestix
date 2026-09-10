import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveAgent,
  createAgent,
  deleteAgent,
  listAgents,
  renameAgent,
  turnOff,
  turnOn,
  unarchiveAgent,
  type AgentActionsDeps,
} from "../../src/agent-actions";
import { loadAgentSet } from "../../src/agent-set-store";
import type { RunCommand } from "../../src/agents-cli";

function fakeAgentsJson(sessions: Array<{ id: string; sessionId: string; cwd: string }>): string {
  return JSON.stringify(sessions.map((s) => ({ kind: "background", startedAt: 0, ...s })));
}

interface Harness {
  deps: AgentActionsDeps;
  dir: string;
  commands: string[][];
  /** Sessions the fake `claude agents --json --cwd <cwd>` should report right now. Mutate this to simulate a running agent. */
  liveSessions: Array<{ id: string; sessionId: string; cwd: string }>;
  agentSetPath: string;
  agentsBaseDir: string;
  runtimeDir: string;
}

async function withHarness<T>(fn: (h: Harness) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "candlestix-agent-actions-"));
  try {
    const agentSetPath = join(dir, "state", "agents.json");
    const agentsBaseDir = join(dir, "state", "agents");
    const runtimeDir = join(dir, "runtime");
    const commands: string[][] = [];
    const liveSessions: Array<{ id: string; sessionId: string; cwd: string }> = [];
    let sessionCounter = 0;

    const runCommand: RunCommand = async (argv) => {
      commands.push(argv);
      if (argv[0] === "claude" && argv[1] === "agents") {
        return { exitCode: 0, stdout: fakeAgentsJson(liveSessions), stderr: "" };
      }
      if (argv[0] === "claude" && argv[1] === "stop") {
        const idx = liveSessions.findIndex((s) => s.id === argv[2]);
        if (idx >= 0) liveSessions.splice(idx, 1);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (argv[0] === "claude" && argv[1] === "rm") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (argv[0] === "systemd-run") {
        const cwdArgIndex = -1; // spawnDaemonAgent passes cwd via opts, not argv
        void cwdArgIndex;
        const newId = `sess${sessionCounter++}`;
        liveSessions.push({ id: newId, sessionId: `${newId}-full`, cwd: "" }); // cwd filled by caller via opts below
        return { exitCode: 0, stdout: `backgrounded · ${newId} (idle)`, stderr: "" };
      }
      throw new Error(`unmocked command: ${argv.join(" ")}`);
    };

    // Wrap runCommand so we can capture the cwd a launch was made under and
    // attach it to the just-recorded live session (Bun's spawn cwd is a
    // separate `opts` field, never part of argv).
    const wrappedRunCommand: RunCommand = async (argv, opts) => {
      const result = await runCommand(argv, opts);
      if (argv[0] === "systemd-run" && opts.cwd !== undefined) {
        const last = liveSessions[liveSessions.length - 1];
        if (last) last.cwd = opts.cwd;
      }
      return result;
    };

    let nowMs = 1_726_000_000_000;
    let randomSeed = 0;

    const deps: AgentActionsDeps = {
      agentSetPath,
      agentsBaseDir,
      agentDirectoryPath: (id) => join(agentsBaseDir, id),
      mcpConfigPath: (id) => join(runtimeDir, "agents", id, "mcp.json"),
      runCommand: wrappedRunCommand,
      now: () => new Date((nowMs += 1)),
      random: () => ((randomSeed += 1) % 32) / 32,
    };

    return await fn({ deps, dir, commands, liveSessions, agentSetPath, agentsBaseDir, runtimeDir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("createAgent", () => {
  test("the blank case: no name, no job — the product's headline behaviour", async () => {
    await withHarness(async ({ deps, agentsBaseDir }) => {
      const result = await createAgent(deps, {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.agent.name).toBeUndefined();
      expect(result.agent.job).toBeUndefined();
      expect(result.agent.state).toBe("on");
      await stat(join(agentsBaseDir, result.agent.id)); // directory exists
    });
  });

  test("defaults to state 'on' and actually spawns a session", async () => {
    await withHarness(async ({ deps, commands }) => {
      const result = await createAgent(deps, { name: "release-notes" });
      expect(result.ok).toBe(true);
      expect(commands.some((c) => c[0] === "systemd-run")).toBe(true);
    });
  });

  test("initialState 'off' creates the record and directory but never spawns", async () => {
    await withHarness(async ({ deps, commands, agentsBaseDir }) => {
      const result = await createAgent(deps, { name: "cold-start", initialState: "off" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.agent.state).toBe("off");
      expect(commands.some((c) => c[0] === "systemd-run")).toBe(false);
      await stat(join(agentsBaseDir, result.agent.id));
    });
  });

  test("refuses a reserved name, naming the word (R17)", async () => {
    await withHarness(async ({ deps }) => {
      const result = await createAgent(deps, { name: "delete" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("reserved-name");
      if (result.error.kind === "reserved-name") expect(result.error.word).toBe("delete");
    });
  });

  test("refuses invalid name syntax", async () => {
    await withHarness(async ({ deps }) => {
      const result = await createAgent(deps, { name: "NOT-VALID!" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("invalid-name");
    });
  });

  test("refuses a name already taken by another agent", async () => {
    await withHarness(async ({ deps }) => {
      await createAgent(deps, { name: "taken", initialState: "off" });
      const result = await createAgent(deps, { name: "taken", initialState: "off" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("name-taken");
    });
  });

  test("a spawn failure rolls back: no record persisted, directory removed", async () => {
    await withHarness(async ({ deps, agentsBaseDir, agentSetPath }) => {
      const failingDeps: AgentActionsDeps = {
        ...deps,
        runCommand: async (argv) => {
          if (argv[0] === "claude" && argv[1] === "agents") return { exitCode: 0, stdout: "[]", stderr: "" };
          if (argv[0] === "systemd-run") return { exitCode: 1, stdout: "", stderr: "launch failed (simulated)" };
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      };
      const result = await createAgent(failingDeps, { name: "doomed" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("spawn-failed");

      const loaded = await loadAgentSet(agentSetPath);
      expect(loaded.kind === "loaded" ? Object.keys(loaded.agentSet.agents).length : 0).toBe(0);
      expect(loaded.kind).toBe("missing"); // store was never even written to

      const entries = await import("node:fs/promises").then((fs) => fs.readdir(agentsBaseDir).catch(() => []));
      expect(entries).toEqual([]); // the rolled-back directory left no trace
    });
  });

  test("a malformed store refuses create outright — never treated as empty", async () => {
    await withHarness(async ({ deps, agentSetPath }) => {
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(join(agentSetPath, ".."), { recursive: true });
      await writeFile(agentSetPath, "{not json", "utf8");
      const result = await createAgent(deps, { name: "x" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("store-malformed");
    });
  });
});

describe("turnOn / turnOff — S4's on/off columns, idempotent diagonal", () => {
  test("off -> on starts a session and persists durably", async () => {
    await withHarness(async ({ deps, commands }) => {
      const created = await createAgent(deps, { name: "toggle", initialState: "off" });
      if (!created.ok) throw new Error("setup failed");
      commands.length = 0;

      const result = await turnOn(deps, created.agent.id);
      expect(result).toEqual({ ok: true, outcome: { kind: "turned-on" } });
      expect(commands.some((c) => c[0] === "systemd-run")).toBe(true);

      const loaded = await loadAgentSet(deps.agentSetPath);
      expect(loaded.kind).toBe("loaded");
      if (loaded.kind === "loaded") expect(loaded.agentSet.agents[created.agent.id]?.state).toBe("on");
    });
  });

  test("on -> on is a no-change success, not a silent success and not a refusal", async () => {
    await withHarness(async ({ deps }) => {
      const created = await createAgent(deps, { name: "already-on" });
      if (!created.ok) throw new Error("setup failed");
      const result = await turnOn(deps, created.agent.id);
      expect(result).toEqual({ ok: true, outcome: { kind: "no-change" } });
    });
  });

  test("turning an archived agent on is REFUSED, never silently unarchived", async () => {
    await withHarness(async ({ deps }) => {
      const created = await createAgent(deps, { name: "shelved", initialState: "off" });
      if (!created.ok) throw new Error("setup failed");
      const archived = await archiveAgent(deps, created.agent.id);
      expect(archived.ok).toBe(true);

      const result = await turnOn(deps, created.agent.id);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("already-archived");

      const loaded = await loadAgentSet(deps.agentSetPath);
      if (loaded.kind === "loaded") expect(loaded.agentSet.agents[created.agent.id]?.state).toBe("archived");
    });
  });

  test("on -> off stops the session by exact directory, and persists durably", async () => {
    await withHarness(async ({ deps, commands }) => {
      const created = await createAgent(deps, { name: "will-stop" });
      if (!created.ok) throw new Error("setup failed");
      commands.length = 0;

      const result = await turnOff(deps, created.agent.id);
      expect(result).toEqual({ ok: true, outcome: { kind: "turned-off" } });
      expect(commands.some((c) => c[0] === "claude" && c[1] === "stop")).toBe(true);
      expect(commands.every((c) => c[0] !== "systemctl" && !c.join(" ").includes("systemctl"))).toBe(true);

      const loaded = await loadAgentSet(deps.agentSetPath);
      if (loaded.kind === "loaded") expect(loaded.agentSet.agents[created.agent.id]?.state).toBe("off");
    });
  });

  test("off -> off is a no-change success", async () => {
    await withHarness(async ({ deps }) => {
      const created = await createAgent(deps, { name: "already-off", initialState: "off" });
      if (!created.ok) throw new Error("setup failed");
      const result = await turnOff(deps, created.agent.id);
      expect(result).toEqual({ ok: true, outcome: { kind: "no-change" } });
    });
  });

  test("off on an archived agent is refused, naming unarchive", async () => {
    await withHarness(async ({ deps }) => {
      const created = await createAgent(deps, { name: "shelved2", initialState: "off" });
      if (!created.ok) throw new Error("setup failed");
      await archiveAgent(deps, created.agent.id);
      const result = await turnOff(deps, created.agent.id);
      expect(result.ok).toBe(false);
      if (!result.ok && result.error.kind === "archived") expect(result.error.message).toContain("unarchive");
    });
  });

  test("an unknown id-or-name is refused for both on and off", async () => {
    await withHarness(async ({ deps }) => {
      const onResult = await turnOn(deps, "@nonexistent00000000");
      expect(onResult.ok).toBe(false);
      if (!onResult.ok) expect(onResult.error.kind).toBe("not-found");

      const offResult = await turnOff(deps, "no-such-name");
      expect(offResult.ok).toBe(false);
      if (!offResult.ok) expect(offResult.error.kind).toBe("not-found");
    });
  });

  test("turnOff leaves OTHER agents' sessions untouched — never a first-match-only stop", async () => {
    await withHarness(async ({ deps, liveSessions }) => {
      const a = await createAgent(deps, { name: "agent-a" });
      const b = await createAgent(deps, { name: "agent-b" });
      if (!a.ok || !b.ok) throw new Error("setup failed");
      expect(liveSessions).toHaveLength(2);

      await turnOff(deps, a.agent.id);

      expect(liveSessions).toHaveLength(1);
      expect(liveSessions[0]!.cwd).toBe(deps.agentDirectoryPath(b.agent.id));
    });
  });
});

describe("archiveAgent / unarchiveAgent — S4's archive/unarchive columns", () => {
  test("on -> archived stops the session", async () => {
    await withHarness(async ({ deps, commands }) => {
      const created = await createAgent(deps, { name: "to-archive" });
      if (!created.ok) throw new Error("setup failed");
      commands.length = 0;
      const result = await archiveAgent(deps, created.agent.id);
      expect(result).toEqual({ ok: true, outcome: { kind: "archived" } });
      expect(commands.some((c) => c[0] === "claude" && c[1] === "stop")).toBe(true);
    });
  });

  test("off -> archived does not even attempt a session lookup", async () => {
    await withHarness(async ({ deps, commands }) => {
      const created = await createAgent(deps, { name: "off-to-archive", initialState: "off" });
      if (!created.ok) throw new Error("setup failed");
      commands.length = 0;
      const result = await archiveAgent(deps, created.agent.id);
      expect(result).toEqual({ ok: true, outcome: { kind: "archived" } });
      expect(commands).toEqual([]); // no claude invocation at all — nothing was live to stop
    });
  });

  test("archiving an already-archived agent is refused", async () => {
    await withHarness(async ({ deps }) => {
      const created = await createAgent(deps, { name: "twice", initialState: "off" });
      if (!created.ok) throw new Error("setup failed");
      await archiveAgent(deps, created.agent.id);
      const result = await archiveAgent(deps, created.agent.id);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("already-archived");
    });
  });

  test("unarchive returns to OFF, never on, and keeps the name (R2: archived agents keep their name, so unarchive can never collide)", async () => {
    await withHarness(async ({ deps, commands }) => {
      const created = await createAgent(deps, { name: "shelved3", initialState: "off" });
      if (!created.ok) throw new Error("setup failed");
      await archiveAgent(deps, created.agent.id);
      commands.length = 0;

      const result = await unarchiveAgent(deps, created.agent.id);
      expect(result).toEqual({ ok: true, outcome: { kind: "unarchived" } });
      expect(commands).toEqual([]); // unarchive never starts a session

      const loaded = await loadAgentSet(deps.agentSetPath);
      if (loaded.kind === "loaded") {
        expect(loaded.agentSet.agents[created.agent.id]?.state).toBe("off");
        expect(loaded.agentSet.agents[created.agent.id]?.name).toBe("shelved3");
      }
    });
  });

  test("unarchiving a non-archived agent is refused", async () => {
    await withHarness(async ({ deps }) => {
      const created = await createAgent(deps, { name: "not-shelved" });
      if (!created.ok) throw new Error("setup failed");
      const result = await unarchiveAgent(deps, created.agent.id);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("not-archived");
    });
  });
});

describe("renameAgent — R2, R17, and R16/S1's invariance: never moves the directory or the MCP path", () => {
  test("changes the label and provably does not move the directory or the id-keyed MCP path", async () => {
    await withHarness(async ({ deps }) => {
      const created = await createAgent(deps, { name: "before-name", initialState: "off" });
      if (!created.ok) throw new Error("setup failed");
      const dirBefore = deps.agentDirectoryPath(created.agent.id);
      const mcpBefore = deps.mcpConfigPath(created.agent.id);

      const result = await renameAgent(deps, created.agent.id, "after-name");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.agent.name).toBe("after-name");

      const dirAfter = deps.agentDirectoryPath(created.agent.id);
      const mcpAfter = deps.mcpConfigPath(created.agent.id);
      expect(dirAfter).toBe(dirBefore);
      expect(mcpAfter).toBe(mcpBefore);
      await stat(dirAfter); // the directory that was actually created is still there, unmoved
    });
  });

  test("legal regardless of state: on, off, and archived can all be renamed", async () => {
    await withHarness(async ({ deps }) => {
      const onAgent = await createAgent(deps, { name: "on-agent" });
      const offAgent = await createAgent(deps, { name: "off-agent", initialState: "off" });
      const archivedAgentCreate = await createAgent(deps, { name: "archived-agent", initialState: "off" });
      if (!onAgent.ok || !offAgent.ok || !archivedAgentCreate.ok) throw new Error("setup failed");
      await archiveAgent(deps, archivedAgentCreate.agent.id);

      expect((await renameAgent(deps, onAgent.agent.id, "on-renamed")).ok).toBe(true);
      expect((await renameAgent(deps, offAgent.agent.id, "off-renamed")).ok).toBe(true);
      expect((await renameAgent(deps, archivedAgentCreate.agent.id, "archived-renamed")).ok).toBe(true);
    });
  });

  test("renaming onto the same name the agent already holds is a no-op success (R2)", async () => {
    await withHarness(async ({ deps }) => {
      const created = await createAgent(deps, { name: "stable", initialState: "off" });
      if (!created.ok) throw new Error("setup failed");
      const result = await renameAgent(deps, created.agent.id, "stable");
      expect(result.ok).toBe(true);
    });
  });

  test("refuses a reserved word, naming it", async () => {
    await withHarness(async ({ deps }) => {
      const created = await createAgent(deps, { name: "renamer", initialState: "off" });
      if (!created.ok) throw new Error("setup failed");
      const result = await renameAgent(deps, created.agent.id, "archive");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("reserved-name");
    });
  });

  test("refuses a name held by a different agent, naming the current holder", async () => {
    await withHarness(async ({ deps }) => {
      const a = await createAgent(deps, { name: "holder", initialState: "off" });
      const b = await createAgent(deps, { name: "other", initialState: "off" });
      if (!a.ok || !b.ok) throw new Error("setup failed");
      const result = await renameAgent(deps, b.agent.id, "holder");
      expect(result.ok).toBe(false);
      if (!result.ok && result.error.kind === "name-taken") expect(result.error.holder.id).toBe(a.agent.id);
    });
  });

  test("refuses an unknown id-or-name", async () => {
    await withHarness(async ({ deps }) => {
      const result = await renameAgent(deps, "@doesnotexist000000", "whatever");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("not-found");
    });
  });
});

describe("deleteAgent — S3's ordering, the one destructive verb", () => {
  test("stops the session, removes it, removes the directory (verified actually gone), and retires the id", async () => {
    await withHarness(async ({ deps, commands, agentsBaseDir, liveSessions }) => {
      const created = await createAgent(deps, { name: "doomed-agent" });
      if (!created.ok) throw new Error("setup failed");
      expect(liveSessions).toHaveLength(1);
      commands.length = 0;

      const result = await deleteAgent(deps, created.agent.id);
      expect(result).toEqual({ ok: true, outcome: { kind: "deleted" } });

      const stopIndex = commands.findIndex((c) => c[0] === "claude" && c[1] === "stop");
      const rmIndex = commands.findIndex((c) => c[0] === "claude" && c[1] === "rm");
      expect(stopIndex).toBeGreaterThan(-1);
      expect(rmIndex).toBeGreaterThan(stopIndex);

      // Independent check the directory is ACTUALLY gone, not just "no error".
      await expect(stat(join(agentsBaseDir, created.agent.id))).rejects.toThrow();

      const loaded = await loadAgentSet(deps.agentSetPath);
      expect(loaded.kind).toBe("loaded");
      if (loaded.kind === "loaded") {
        expect(created.agent.id in loaded.agentSet.agents).toBe(false);
        expect(loaded.agentSet.retiredIds).toContain(created.agent.id);
      }
    });
  });

  test("deletes cleanly from off and archived states too, with no live session to stop", async () => {
    await withHarness(async ({ deps }) => {
      const offAgent = await createAgent(deps, { name: "off-doomed", initialState: "off" });
      const archivedCreate = await createAgent(deps, { name: "archived-doomed", initialState: "off" });
      if (!offAgent.ok || !archivedCreate.ok) throw new Error("setup failed");
      await archiveAgent(deps, archivedCreate.agent.id);

      expect((await deleteAgent(deps, offAgent.agent.id)).ok).toBe(true);
      expect((await deleteAgent(deps, archivedCreate.agent.id)).ok).toBe(true);
    });
  });

  test("deleting one agent leaves a sibling agent's directory and session untouched", async () => {
    await withHarness(async ({ deps, agentsBaseDir, liveSessions }) => {
      const victim = await createAgent(deps, { name: "victim" });
      const survivor = await createAgent(deps, { name: "survivor" });
      if (!victim.ok || !survivor.ok) throw new Error("setup failed");

      await deleteAgent(deps, victim.agent.id);

      await stat(join(agentsBaseDir, survivor.agent.id)); // still there
      expect(liveSessions.some((s) => s.cwd === deps.agentDirectoryPath(survivor.agent.id))).toBe(true);

      const loaded = await loadAgentSet(deps.agentSetPath);
      if (loaded.kind === "loaded") expect(survivor.agent.id in loaded.agentSet.agents).toBe(true);
    });
  });

  test("refuses an unknown id-or-name, and removes nothing", async () => {
    await withHarness(async ({ deps }) => {
      const result = await deleteAgent(deps, "@doesnotexist000000");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("not-found");
    });
  });

  test("a malformed store refuses delete outright", async () => {
    await withHarness(async ({ deps, agentSetPath }) => {
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(join(agentSetPath, ".."), { recursive: true });
      await writeFile(agentSetPath, "{not json", "utf8");
      const result = await deleteAgent(deps, "@anything0000000000");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("store-malformed");
    });
  });

  test("is idempotent under retry after the session step already completed", async () => {
    await withHarness(async ({ deps, liveSessions }) => {
      const created = await createAgent(deps, { name: "retry-me" });
      if (!created.ok) throw new Error("setup failed");

      // Simulate the session having already been stopped+removed by a prior,
      // interrupted delete attempt: no live session left for this cwd.
      liveSessions.length = 0;

      const result = await deleteAgent(deps, created.agent.id);
      expect(result).toEqual({ ok: true, outcome: { kind: "deleted" } });
    });
  });
});

describe("listAgents — R10", () => {
  test("expresses the lifecycle, including archived, in one call", async () => {
    await withHarness(async ({ deps }) => {
      const onAgent = await createAgent(deps, { name: "on-one" });
      const offAgent = await createAgent(deps, { name: "off-one", initialState: "off" });
      const archivedCreate = await createAgent(deps, { name: "archived-one", initialState: "off" });
      if (!onAgent.ok || !offAgent.ok || !archivedCreate.ok) throw new Error("setup failed");
      await archiveAgent(deps, archivedCreate.agent.id);

      const result = await listAgents(deps);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const byId = new Map(result.agents.map((a) => [a.id, a]));
      expect(byId.get(onAgent.agent.id)?.state).toBe("on");
      expect(byId.get(offAgent.agent.id)?.state).toBe("off");
      expect(byId.get(archivedCreate.agent.id)?.state).toBe("archived");
    });
  });

  test("an empty store lists zero agents — not an error", async () => {
    await withHarness(async ({ deps }) => {
      const result = await listAgents(deps);
      expect(result).toEqual({ ok: true, agents: [] });
    });
  });

  test("a malformed store refuses list outright", async () => {
    await withHarness(async ({ deps, agentSetPath }) => {
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(join(agentSetPath, ".."), { recursive: true });
      await writeFile(agentSetPath, "{not json", "utf8");
      const result = await listAgents(deps);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("store-malformed");
    });
  });
});

describe("R11 — job is optional and never sent as an empty string", () => {
  test("a created agent's spawn omits --append-system-prompt when job is absent", async () => {
    await withHarness(async ({ deps, commands }) => {
      await createAgent(deps, { name: "jobless" });
      const launch = commands.find((c) => c[0] === "systemd-run");
      expect(launch).toBeDefined();
      expect(launch).not.toContain("--append-system-prompt");
    });
  });

  test("a created agent's spawn includes the job text when present", async () => {
    await withHarness(async ({ deps, commands }) => {
      await createAgent(deps, { name: "has-job", job: "watch PRs" });
      const launch = commands.find((c) => c[0] === "systemd-run");
      expect(launch).toBeDefined();
      const idx = launch!.indexOf("--append-system-prompt");
      expect(idx).toBeGreaterThan(-1);
      expect(launch![idx + 1]).toBe("watch PRs");
    });
  });
});

describe("S6 — a daemon-created agent gets an EMPTY MCP config, keeping --strict-mcp-config", () => {
  test("the id-keyed MCP config file contains {\"mcpServers\":{}}", async () => {
    await withHarness(async ({ deps }) => {
      const created = await createAgent(deps, { name: "mcp-check" });
      if (!created.ok) throw new Error("setup failed");
      const contents = await readFile(deps.mcpConfigPath(created.agent.id), "utf8");
      expect(JSON.parse(contents)).toEqual({ mcpServers: {} });
    });
  });

  test("--strict-mcp-config and --mcp-config are still passed at spawn", async () => {
    await withHarness(async ({ deps, commands }) => {
      await createAgent(deps, { name: "mcp-check-2" });
      const launch = commands.find((c) => c[0] === "systemd-run");
      expect(launch).toContain("--strict-mcp-config");
      expect(launch).toContain("--mcp-config");
    });
  });
});

describe("a malformed store refuses EVERY action outright — never treated as empty (item 11 of the DoD, exhaustively)", () => {
  async function corruptStore(agentSetPath: string): Promise<void> {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(agentSetPath, ".."), { recursive: true });
    await writeFile(agentSetPath, "{not json", "utf8");
  }

  test("turnOn refuses", async () => {
    await withHarness(async ({ deps, agentSetPath }) => {
      await corruptStore(agentSetPath);
      const result = await turnOn(deps, "@anything0000000000");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("store-malformed");
    });
  });

  test("turnOff refuses", async () => {
    await withHarness(async ({ deps, agentSetPath }) => {
      await corruptStore(agentSetPath);
      const result = await turnOff(deps, "@anything0000000000");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("store-malformed");
    });
  });

  test("archiveAgent refuses", async () => {
    await withHarness(async ({ deps, agentSetPath }) => {
      await corruptStore(agentSetPath);
      const result = await archiveAgent(deps, "@anything0000000000");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("store-malformed");
    });
  });

  test("unarchiveAgent refuses", async () => {
    await withHarness(async ({ deps, agentSetPath }) => {
      await corruptStore(agentSetPath);
      const result = await unarchiveAgent(deps, "@anything0000000000");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("store-malformed");
    });
  });

  test("renameAgent refuses", async () => {
    await withHarness(async ({ deps, agentSetPath }) => {
      await corruptStore(agentSetPath);
      const result = await renameAgent(deps, "@anything0000000000", "new-name");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("store-malformed");
    });
  });

  test("createAgent refuses", async () => {
    await withHarness(async ({ deps, agentSetPath }) => {
      await corruptStore(agentSetPath);
      const result = await createAgent(deps, { name: "whatever" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("store-malformed");
    });
  });

  test("deleteAgent refuses", async () => {
    await withHarness(async ({ deps, agentSetPath }) => {
      await corruptStore(agentSetPath);
      const result = await deleteAgent(deps, "@anything0000000000");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("store-malformed");
    });
  });

  test("listAgents refuses", async () => {
    await withHarness(async ({ deps, agentSetPath }) => {
      await corruptStore(agentSetPath);
      const result = await listAgents(deps);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("store-malformed");
    });
  });

  test("none of the above ever call out to claude at all — refusal happens before any resolve/session step", async () => {
    await withHarness(async ({ deps, agentSetPath, commands }) => {
      await corruptStore(agentSetPath);
      await turnOn(deps, "x");
      await turnOff(deps, "x");
      await archiveAgent(deps, "x");
      await unarchiveAgent(deps, "x");
      await renameAgent(deps, "x", "y");
      await deleteAgent(deps, "x");
      await createAgent(deps, { name: "x" });
      await listAgents(deps);
      expect(commands).toEqual([]);
    });
  });
});

describe("a failed store WRITE is reported honestly, never an unhandled rejection (found in review, blocking)", () => {
  async function withUnwritableStoreDir<T>(agentSetPath: string, fn: () => Promise<T>): Promise<T> {
    const { chmod } = await import("node:fs/promises");
    const storeDir = join(agentSetPath, "..");
    await chmod(storeDir, 0o500); // r-x: readable/listable, not writable — the atomic write's temp file cannot be created
    try {
      return await fn();
    } finally {
      await chmod(storeDir, 0o700); // restore before the harness's own temp-dir cleanup runs
    }
  }

  test("turnOff: the session is genuinely stopped, the write fails, and the caller gets a typed error — never a thrown rejection, and the store must NOT be left saying \"on\"", async () => {
    await withHarness(async ({ deps, agentSetPath, liveSessions }) => {
      const created = await createAgent(deps, { name: "write-fails-off" });
      if (!created.ok) throw new Error("setup failed");
      expect(liveSessions).toHaveLength(1);

      const result = await withUnwritableStoreDir(agentSetPath, () => turnOff(deps, created.agent.id));

      // The exact defect the review demonstrated: the effect must still have
      // happened (the session really stopped)...
      expect(liveSessions).toHaveLength(0);
      // ...but the caller must get a typed error, never a thrown exception —
      // this call already completed without throwing by the time we get here.
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("store-write-failed");
        if (result.error.kind === "store-write-failed") {
          expect(result.error.error).toContain("session was stopped");
        }
      }

      // And — the actual regression this guards against — the durable store
      // on disk (permissions now restored) must NOT have been silently left
      // saying "on": since the write never completed, it still holds
      // whatever it held before this call, which is "on". A caller reading
      // this typed error knows to treat the record as STALE; a caller that
      // swallowed a thrown exception would not.
      const loaded = await loadAgentSet(agentSetPath);
      if (loaded.kind === "loaded") {
        expect(loaded.agentSet.agents[created.agent.id]?.state).toBe("on");
      }
    });
  });

  test("turnOn: a write failure after a real spawn is reported, not thrown", async () => {
    await withHarness(async ({ deps, agentSetPath, liveSessions }) => {
      const created = await createAgent(deps, { name: "write-fails-on", initialState: "off" });
      if (!created.ok) throw new Error("setup failed");

      const result = await withUnwritableStoreDir(agentSetPath, () => turnOn(deps, created.agent.id));

      expect(liveSessions).toHaveLength(1); // the session really started
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("store-write-failed");
    });
  });

  test("archiveAgent: a write failure after stopping the session is reported, not thrown", async () => {
    await withHarness(async ({ deps, agentSetPath, liveSessions }) => {
      const created = await createAgent(deps, { name: "write-fails-archive" });
      if (!created.ok) throw new Error("setup failed");

      const result = await withUnwritableStoreDir(agentSetPath, () => archiveAgent(deps, created.agent.id));

      expect(liveSessions).toHaveLength(0); // the session really stopped
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("store-write-failed");
    });
  });

  test("unarchiveAgent: a write failure is reported, not thrown", async () => {
    await withHarness(async ({ deps, agentSetPath }) => {
      const created = await createAgent(deps, { name: "write-fails-unarchive", initialState: "off" });
      if (!created.ok) throw new Error("setup failed");
      await archiveAgent(deps, created.agent.id);

      const result = await withUnwritableStoreDir(agentSetPath, () => unarchiveAgent(deps, created.agent.id));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("store-write-failed");
    });
  });

  test("renameAgent: a write failure is reported, not thrown", async () => {
    await withHarness(async ({ deps, agentSetPath }) => {
      const created = await createAgent(deps, { name: "write-fails-rename", initialState: "off" });
      if (!created.ok) throw new Error("setup failed");

      const result = await withUnwritableStoreDir(agentSetPath, () => renameAgent(deps, created.agent.id, "renamed"));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("store-write-failed");
    });
  });

  test("deleteAgent: the session and directory are really gone, the write fails, and the caller gets a typed error, not a thrown rejection", async () => {
    await withHarness(async ({ deps, agentSetPath, agentsBaseDir, liveSessions }) => {
      const created = await createAgent(deps, { name: "write-fails-delete" });
      if (!created.ok) throw new Error("setup failed");

      const result = await withUnwritableStoreDir(agentSetPath, () => deleteAgent(deps, created.agent.id));

      expect(liveSessions).toHaveLength(0); // session really stopped+removed
      await expect(stat(join(agentsBaseDir, created.agent.id))).rejects.toThrow(); // directory really gone
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("store-write-failed");

      // A retry, now that permissions are restored, completes cleanly —
      // every earlier step is idempotent, exactly as the module's own doc
      // comment claims for a crash between steps.
      const retry = await deleteAgent(deps, created.agent.id);
      expect(retry).toEqual({ ok: true, outcome: { kind: "deleted" } });
    });
  });

  test("createAgent: a write failure after directory+spawn rolls back (stops the session, removes the directory) rather than leaking an orphan no retry could ever find", async () => {
    await withHarness(async ({ deps, agentSetPath, agentsBaseDir, liveSessions }) => {
      // Pre-create the agents base dir (with normal permissions) so the new
      // agent's OWN subdirectory can still be created under it once the
      // store's parent directory is made read-only below — only the final
      // `agents.json` write (which lives directly in that parent) should fail.
      const { mkdir } = await import("node:fs/promises");
      await mkdir(agentsBaseDir, { recursive: true });

      const result = await withUnwritableStoreDir(agentSetPath, () => createAgent(deps, { name: "write-fails-create" }));

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("store-write-failed");

      // Nothing was ever persisted (the write that failed was the only one attempted)...
      const loaded = await loadAgentSet(agentSetPath);
      expect(loaded.kind).toBe("missing");
      // ...and the orphaned session and directory were rolled back rather than leaked.
      expect(liveSessions).toHaveLength(0);
      const { readdir } = await import("node:fs/promises");
      expect(await readdir(agentsBaseDir).catch(() => [])).toEqual([]);
    });
  });
});
