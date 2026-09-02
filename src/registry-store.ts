import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { emptyRegistry, parseRegistry, serializeRegistry, type Registry } from "./registry";
import { log } from "./log";

/**
 * Loads the registry from `path`. A missing file (first run) is the empty
 * registry — genuinely different from "unreadable" or "malformed", which
 * are logged loudly and ALSO fall back to empty rather than crashing the
 * daemon, because a lost registry is recoverable (see reconcile.ts's
 * adopt-by-cwd fallback) and refusing to start over a corrupt bookkeeping
 * file would not be.
 */
export async function loadRegistry(path: string): Promise<Registry> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyRegistry();
    }
    log("error", `could not read registry at "${path}", starting from empty (will re-adopt from claude's own state): ${err instanceof Error ? err.message : String(err)}`);
    return emptyRegistry();
  }

  const result = parseRegistry(source);
  if (!result.ok) {
    log("error", `registry at "${path}" is malformed, starting from empty (will re-adopt from claude's own state): ${result.error}`);
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
