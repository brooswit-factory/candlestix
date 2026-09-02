import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRoster } from "../../src/roster-source";

describe("loadRoster", () => {
  test("reads and parses a valid roster file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "candlestix-roster-"));
    try {
      const path = join(dir, "roster.yaml");
      await writeFile(path, "agents:\n  - name: a\n    job: do things\n    cwd: /tmp\n    mcpServers: {}\n", "utf8");
      const result = await loadRoster(path);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.roster.agents).toHaveLength(1);
        expect(result.roster.agents[0]!.name).toBe("a");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a missing file is reported as an error, never as a silently-empty roster", async () => {
    const result = await loadRoster("/definitely/does/not/exist/roster.yaml");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join()).toMatch(/could not read roster/);
    }
  });

  test("invalid roster content surfaces parseRoster's own errors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "candlestix-roster-"));
    try {
      const path = join(dir, "roster.yaml");
      await writeFile(path, "not: a valid roster\n", "utf8");
      const result = await loadRoster(path);
      expect(result.ok).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
