import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentDirectory, guardAgentDirectoryRemoval, removeAgentDirectory } from "../../src/agent-directory";
import { mintAgentId } from "../../src/agent-id";

function id(seed: number): string {
  return mintAgentId({ now: () => new Date(1_726_000_000_000 + seed), random: () => (seed % 32) / 32 });
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "candlestix-agent-directory-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("guardAgentDirectoryRemoval — S3's recursive-delete guard, pure", () => {
  const base = "/state/candlestix/agents";

  test("a valid minted id resolves to a direct child of the base dir", () => {
    const validId = id(1);
    expect(guardAgentDirectoryRemoval(base, validId)).toEqual({ ok: true, path: `${base}/${validId}` });
  });

  const hostileInputs = [
    "", // empty
    "..", // parent traversal
    "../../etc/passwd", // deep traversal
    "/etc/passwd", // absolute, unrelated tree
    "/state/candlestix/agents", // the base dir itself
    "@not-32-chars", // wrong length
    "not-even-id-shaped",
    "@01m24dm7tbg3wxc/j9", // id-shaped but with a path separator smuggled in
    "@01m24dm7tbg3wxc..j9", // id-shaped but with ".." smuggled in
  ];

  for (const hostile of hostileInputs) {
    test(`refuses hostile input ${JSON.stringify(hostile)}`, () => {
      const result = guardAgentDirectoryRemoval(base, hostile);
      expect(result.ok).toBe(false);
    });
  }

  test("a sibling directory outside the base is never treated as a direct child", () => {
    // Even a syntactically id-shaped string could only ever resolve under
    // `base` (isAgentId's alphabet excludes "/"), but the direct-child check
    // is asserted independently of that fact, per S3's belt-and-suspenders
    // framing.
    const validId = id(2);
    const result = guardAgentDirectoryRemoval(base, validId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path.startsWith(`${base}/`)).toBe(true);
      expect(result.path).not.toBe(base);
    }
  });
});

describe("removeAgentDirectory — the guard is load-bearing, not decorative", () => {
  test("a hostile id refuses AND leaves every real file on disk untouched", async () => {
    await withTempDir(async (dir) => {
      const agentsBase = join(dir, "agents");
      const decoyOutside = join(dir, "decoy-outside.txt");
      await writeFile(decoyOutside, "do not remove me");
      await mkdir(agentsBase, { recursive: true });
      const decoyInsideBase = join(agentsBase, "decoy-inside-base.txt");
      await writeFile(decoyInsideBase, "do not remove me either");

      for (const hostile of ["", "..", "../decoy-outside.txt", "/etc/passwd"]) {
        const result = await removeAgentDirectory(agentsBase, hostile);
        expect(result.ok).toBe(false);
      }

      // Not just "refusal was reported" — independently re-check the disk.
      expect(await readFile(decoyOutside, "utf8")).toBe("do not remove me");
      expect(await readFile(decoyInsideBase, "utf8")).toBe("do not remove me either");
      await stat(agentsBase); // still exists
    });
  });

  test("a valid id removes exactly that agent's own directory, recursively", async () => {
    await withTempDir(async (dir) => {
      const agentsBase = join(dir, "agents");
      const victim = id(3);
      const survivor = id(4);
      const victimDir = join(agentsBase, victim);
      const survivorDir = join(agentsBase, survivor);
      await mkdir(join(victimDir, "conversation"), { recursive: true });
      await writeFile(join(victimDir, "conversation", "log.jsonl"), "some conversation data");
      await mkdir(survivorDir, { recursive: true });
      await writeFile(join(survivorDir, "marker.txt"), "sibling agent — must survive");

      const result = await removeAgentDirectory(agentsBase, victim);
      expect(result).toEqual({ ok: true });

      await expect(stat(victimDir)).rejects.toThrow();
      expect(await readFile(join(survivorDir, "marker.txt"), "utf8")).toBe("sibling agent — must survive");
    });
  });

  test("removing an already-absent (but validly id-shaped) directory is a success, not an error — idempotent", async () => {
    await withTempDir(async (dir) => {
      const agentsBase = join(dir, "agents");
      await mkdir(agentsBase, { recursive: true });
      const result = await removeAgentDirectory(agentsBase, id(5));
      expect(result).toEqual({ ok: true });
    });
  });

  test("a real removal failure (not the guard) is surfaced as ok:false with a reason, not swallowed", async () => {
    await withTempDir(async (dir) => {
      const agentsBase = join(dir, "agents");
      const failing = id(6);
      const result = await removeAgentDirectory(agentsBase, failing, async () => {
        throw new Error("EACCES: permission denied (simulated)");
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("EACCES");
    });
  });
});

describe("createAgentDirectory — S1", () => {
  test("creates the directory, and is idempotent on a directory that already exists", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "agents", id(7));
      await createAgentDirectory(path);
      await stat(path); // does not throw
      await createAgentDirectory(path); // does not throw the second time either
    });
  });
});
