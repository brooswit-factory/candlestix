import { readFile } from "node:fs/promises";
import { parseRoster, type Roster } from "./roster";

export type LoadRosterResult =
  | { ok: true; roster: Roster }
  | { ok: false; errors: string[] };

/**
 * Reads the roster from `path` and parses it. A missing file is reported
 * as an error (not as an empty roster) — silently treating "no file yet"
 * as "zero agents" would make a typo'd path indistinguishable from a
 * deliberately empty roster, and the operator would get no signal either
 * way. `parseRoster` itself never throws (see roster.ts); the only new
 * failure mode this adds is the read itself.
 */
export async function loadRoster(path: string): Promise<LoadRosterResult> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, errors: [`could not read roster at "${path}": ${detail}`] };
  }

  const result = parseRoster(source);
  if (!result.ok) {
    return { ok: false, errors: result.errors.map((e) => e.message) };
  }
  return { ok: true, roster: result.roster };
}
