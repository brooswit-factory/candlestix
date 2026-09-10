// Impure load/save for the durable agent set (CNDLX-22 / CNDLX-17). Thin
// on purpose: the only logic here is the read/write and the atomic-write
// dance; all shape decisions live in the pure agent-set.ts.
//
// THE TRAP THIS MODULE EXISTS TO NOT FALL INTO: src/registry-store.ts's
// `loadRegistry` catches a malformed registry and falls back to the empty
// registry. That is correct for THAT file, because the session registry
// is reconstructable from `claude`'s own live state on the next reconcile
// cycle (see registry.ts's own doc comment). The agent set has no such
// second source of truth — it is reconstructable from NOTHING. Silently
// returning "empty" for a malformed file here would make every agent the
// operator ever created look deleted, and the next save would overwrite
// the very file that still held them. So this loader does NOT mirror that
// fallback: missing-file, malformed, and successfully-read are three
// separate, typed outcomes, and only the caller — which knows whether it
// is safe to proceed on an empty set — gets to decide what a "malformed"
// result means for it.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { emptyAgentSet, parseAgentSet, serializeAgentSet, type AgentSet } from "./agent-set";

export type LoadAgentSetResult =
  /** No file at `path` yet — first run. The empty set, and a SUCCESS: there is nothing wrong here. */
  | { kind: "missing"; agentSet: AgentSet }
  /** The file exists but could not be read or did not parse. NEVER treated as empty — see the module doc above. The caller must decide what to do; this loader will not guess for it. */
  | { kind: "malformed"; error: string }
  /** The file was read and parsed successfully. */
  | { kind: "loaded"; agentSet: AgentSet };

export async function loadAgentSet(path: string): Promise<LoadAgentSetResult> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing", agentSet: emptyAgentSet() };
    }
    return { kind: "malformed", error: `could not read agent set at "${path}": ${err instanceof Error ? err.message : String(err)}` };
  }

  const result = parseAgentSet(source);
  if (!result.ok) {
    return { kind: "malformed", error: `agent set at "${path}" is malformed: ${result.error}` };
  }
  return { kind: "loaded", agentSet: result.agentSet };
}

/** Atomic write: temp file + rename, same pattern as registry-store.ts and health/signal.ts, for the same reason (no reader ever observes a half-written file). */
export async function saveAgentSet(path: string, agentSet: AgentSet): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = join(dirname(path), `.${randomUUID()}.tmp`);
  await writeFile(tmpPath, serializeAgentSet(agentSet), "utf8");
  await rename(tmpPath, path);
}
