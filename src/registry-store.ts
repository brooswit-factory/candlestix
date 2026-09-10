import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { emptyRegistry, parseRegistry, serializeRegistry, type Registry } from "./registry";
import { log } from "./log";

/**
 * Loads the registry from `path`. A missing file (first run) is the empty
 * registry — genuinely different from "unreadable", "malformed", or
 * "legacy" (see registry.ts), all three of which are logged loudly and
 * ALSO fall back to empty rather than crashing the daemon, because a lost
 * registry is recoverable (see reconcile.ts's adopt-by-directory fallback)
 * and refusing to start over a corrupt or superseded bookkeeping file would
 * not be. "Legacy" (CNDLX-19 T4) gets its own, distinct message: a
 * pre-CNDLX-19, name-keyed file is NOT corrupt, and calling it "malformed"
 * would send an operator hunting for damage that does not exist.
 */
export async function loadRegistry(path: string): Promise<Registry> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyRegistry();
    }
    log(
      "error",
      `could not read registry at "${path}", starting from empty (will re-adopt from claude's own state): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return emptyRegistry();
  }

  const result = parseRegistry(source);
  if (!result.ok) {
    if (result.kind === "legacy") {
      log(
        "warn",
        `registry at "${path}" is in the pre-CNDLX-19 name-keyed format (version 1) — not malformed, just superseded by the id-keyed format; discarding it, the mapping self-heals from claude's own live state this cycle`
      );
    } else {
      log("error", `registry at "${path}" is malformed, starting from empty (will re-adopt from claude's own state): ${result.error}`);
    }
    return emptyRegistry();
  }
  return result.registry;
}

/** Atomic write: temp file + rename, same pattern as health/signal.ts, for the same reason (no reader ever observes a half-written registry). */
export async function saveRegistry(path: string, registry: Registry): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = join(dirname(path), `.${randomUUID()}.tmp`);
  await writeFile(tmpPath, serializeRegistry(registry), "utf8");
  await rename(tmpPath, path);
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
