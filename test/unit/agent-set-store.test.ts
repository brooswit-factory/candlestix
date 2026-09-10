import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentSet, saveAgentSet } from "../../src/agent-set-store";
import { emptyAgentSet, insertAgent } from "../../src/agent-set";
import { mintAgentId } from "../../src/agent-id";
import type { AgentRecord } from "../../src/agent";

const entry: AgentRecord = {
  id: mintAgentId({ now: () => new Date(1_726_000_000_000), random: () => 7 / 32 }),
  name: "release-notes",
  state: "on",
  createdAt: "2026-09-02T00:00:00.000Z",
};

describe("loadAgentSet — three distinct outcomes, not two", () => {
  test("a missing file is 'missing' — success, empty set, NOT an error", async () => {
    const result = await loadAgentSet("/definitely/does/not/exist/agents.json");
    expect(result).toEqual({ kind: "missing", agentSet: emptyAgentSet() });
  });

  test("malformed content is 'malformed' — a distinct typed failure, NEVER collapsed into empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "candlestix-agents-"));
    try {
      const path = join(dir, "agents.json");
      await writeFile(path, "{not json", "utf8");
      const result = await loadAgentSet(path);
      expect(result.kind).toBe("malformed");
      if (result.kind !== "malformed") return;
      expect(result.error).toContain(path);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a well-formed-JSON but wrong-shaped file is also 'malformed', not silently emptied", async () => {
    const dir = await mkdtemp(join(tmpdir(), "candlestix-agents-"));
    try {
      const path = join(dir, "agents.json");
      await writeFile(path, JSON.stringify({ hello: "world" }), "utf8");
      const result = await loadAgentSet(path);
      expect(result.kind).toBe("malformed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a readable, well-formed file is 'loaded'", async () => {
    const dir = await mkdtemp(join(tmpdir(), "candlestix-agents-"));
    try {
      const path = join(dir, "agents.json");
      const inserted = insertAgent(emptyAgentSet(), entry);
      if (!inserted.ok) throw new Error("setup");
      await saveAgentSet(path, inserted.agentSet);
      const result = await loadAgentSet(path);
      expect(result).toEqual({ kind: "loaded", agentSet: inserted.agentSet });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("reload-after-restart — the property the whole epic stands on", () => {
  test("write a set, drop it, load it from the same path in a FRESH call, get the same set back (real temp dir, real file)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "candlestix-agents-restart-"));
    try {
      const path = join(dir, "nested", "agents.json"); // also exercises parent-dir creation
      const inserted = insertAgent(emptyAgentSet(), entry);
      if (!inserted.ok) throw new Error("setup");
      const written = inserted.agentSet;

      await saveAgentSet(path, written);

      // The block above is the only scope holding `written`; nothing below
      // this point reads it. The load that follows must reconstruct the
      // set purely from what actually landed on disk, in a genuinely
      // fresh call — not from anything still resident in memory.
      const reloaded = await loadAgentSet(path);
      expect(reloaded).toEqual({ kind: "loaded", agentSet: written });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("saveAgentSet — atomic write", () => {
  test("no .tmp file is left behind after a successful save", async () => {
    const dir = await mkdtemp(join(tmpdir(), "candlestix-agents-atomic-"));
    try {
      const path = join(dir, "agents.json");
      await saveAgentSet(path, emptyAgentSet());
      const contents = await readFile(path, "utf8");
      expect(JSON.parse(contents)).toEqual(emptyAgentSet());
      const files = await readdir(dir);
      expect(files.every((f) => !f.endsWith(".tmp"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
