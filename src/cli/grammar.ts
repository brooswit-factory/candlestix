// The candlestix CLI's grammar: argv in, a typed command out. Pure — no I/O,
// no network, no filesystem, no process access, so every form and edge case
// is unit-testable without a fake server at all.
//
// R17 / the epic's own instruction, load-bearing: this parser knows exactly
// TWO top-level dispatch words of its own — "list" and "create" — plus the
// SEVEN second-position verbs "on", "off", "archive", "unarchive", "delete",
// "name" and "rename". It does NOT carry a second copy of the action set's
// ten-word reserved-name list (src/agent-lifecycle.ts's
// RESERVED_AGENT_NAMES), and does NOT validate agent name syntax at all —
// both are the action set's job, enforced once, in one place. An id-or-name
// argument that happens to collide with one of this grammar's own words
// (e.g. literally typing `candlestix on`) is simply passed through to the
// daemon as an attach target; it will always refuse as not-found, because
// the action set can never let such a name exist in the first place. A
// reviewer can confirm this file never imports anything from
// agent-lifecycle.ts, agent-set.ts or agent.ts.
//
// The bare word is create. A bare `<id|name>` is attach. Everything else is
// `<id|name> <verb>`.

export type ParsedCommand =
  | { kind: "create"; name?: string; job?: string }
  | { kind: "attach"; idOrName: string }
  | { kind: "on"; idOrName: string }
  | { kind: "off"; idOrName: string }
  | { kind: "archive"; idOrName: string }
  | { kind: "unarchive"; idOrName: string }
  | { kind: "delete"; idOrName: string; yes: boolean }
  | { kind: "rename"; idOrName: string; newName: string }
  | { kind: "list"; showArchived: boolean };

export interface ParseError {
  message: string;
}

export type ParseResult = { ok: true; command: ParsedCommand } | { ok: false; error: ParseError };

const NO_ARG_VERBS = new Set(["on", "off", "archive", "unarchive"]);
const RENAME_VERBS = new Set(["name", "rename"]);

interface ScannedFlags {
  name?: string;
  job?: string;
  yes: boolean;
  archived: boolean;
}

type ScanResult = { ok: true; positionals: string[]; flags: ScannedFlags } | { ok: false; error: ParseError };

/**
 * Splits argv into positionals and known flags, in one left-to-right pass.
 * Any token starting with "-" that is not one of the four recognized flags
 * is refused immediately as a usage error — this is what makes a bare `--`
 * or an unrecognized flag-like token a clear error rather than something
 * that could ever be silently treated as an id-or-name (DoD: "a bare `--`
 * or flag-like argument where a name is expected").
 */
function scan(argv: string[]): ScanResult {
  const positionals: string[] = [];
  const flags: ScannedFlags = { yes: false, archived: false };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (token === "--name") {
      const value = argv[i + 1];
      if (value === undefined) return { ok: false, error: { message: "--name requires a value" } };
      flags.name = value;
      i++;
    } else if (token === "--job") {
      const value = argv[i + 1];
      if (value === undefined) return { ok: false, error: { message: "--job requires a value" } };
      flags.job = value;
      i++;
    } else if (token === "--yes" || token === "-y") {
      flags.yes = true;
    } else if (token === "--archived") {
      flags.archived = true;
    } else if (token.startsWith("-")) {
      return { ok: false, error: { message: `unrecognized flag "${token}"` } };
    } else {
      positionals.push(token);
    }
  }

  return { ok: true, positionals, flags };
}

function usageError(message: string): ParseResult {
  return { ok: false, error: { message } };
}

/** `exactOptionalPropertyTypes` refuses `name: undefined`; build the optional fields conditionally instead. */
function buildCreateCommand(flags: ScannedFlags): ParsedCommand {
  return {
    kind: "create",
    ...(flags.name !== undefined ? { name: flags.name } : {}),
    ...(flags.job !== undefined ? { job: flags.job } : {}),
  };
}

/** Refuses any flag not in `allowed`, naming the first disallowed one found. */
function rejectDisallowedFlags(
  flags: ScannedFlags,
  allowed: { name?: boolean; job?: boolean; yes?: boolean; archived?: boolean },
  commandLabel: string
): ParseError | undefined {
  if (flags.name !== undefined && !allowed.name) return { message: `--name is not valid with "${commandLabel}"` };
  if (flags.job !== undefined && !allowed.job) return { message: `--job is not valid with "${commandLabel}"` };
  if (flags.yes && !allowed.yes) return { message: `--yes/-y is not valid with "${commandLabel}"` };
  if (flags.archived && !allowed.archived) return { message: `--archived is not valid with "${commandLabel}"` };
  return undefined;
}

export function parseArgv(argv: string[]): ParseResult {
  const scanned = scan(argv);
  if (!scanned.ok) return scanned;
  const { positionals, flags } = scanned;

  if (positionals.length === 0) {
    const disallowed = rejectDisallowedFlags(flags, { name: true, job: true }, "create");
    if (disallowed) return { ok: false, error: disallowed };
    return { ok: true, command: buildCreateCommand(flags) };
  }

  const first = positionals[0] as string;

  if (first === "list") {
    if (positionals.length > 1) return usageError(`"list" takes no arguments; got extra: ${positionals.slice(1).join(" ")}`);
    const disallowed = rejectDisallowedFlags(flags, { archived: true }, "list");
    if (disallowed) return { ok: false, error: disallowed };
    return { ok: true, command: { kind: "list", showArchived: flags.archived } };
  }

  if (first === "create") {
    if (positionals.length > 1) return usageError(`"create" takes no positional arguments; got extra: ${positionals.slice(1).join(" ")}`);
    const disallowed = rejectDisallowedFlags(flags, { name: true, job: true }, "create");
    if (disallowed) return { ok: false, error: disallowed };
    return { ok: true, command: buildCreateCommand(flags) };
  }

  const idOrName = first;

  if (positionals.length === 1) {
    const disallowed = rejectDisallowedFlags(flags, {}, "attach");
    if (disallowed) return { ok: false, error: disallowed };
    return { ok: true, command: { kind: "attach", idOrName } };
  }

  const verb = positionals[1] as string;

  if (NO_ARG_VERBS.has(verb)) {
    if (positionals.length > 2) return usageError(`"${verb}" takes no further arguments; got extra: ${positionals.slice(2).join(" ")}`);
    const disallowed = rejectDisallowedFlags(flags, {}, verb);
    if (disallowed) return { ok: false, error: disallowed };
    return { ok: true, command: { kind: verb as "on" | "off" | "archive" | "unarchive", idOrName } };
  }

  if (verb === "delete") {
    if (positionals.length > 2) return usageError(`"delete" takes no further positional arguments; got extra: ${positionals.slice(2).join(" ")}`);
    const disallowed = rejectDisallowedFlags(flags, { yes: true }, "delete");
    if (disallowed) return { ok: false, error: disallowed };
    return { ok: true, command: { kind: "delete", idOrName, yes: flags.yes } };
  }

  if (RENAME_VERBS.has(verb)) {
    if (positionals.length < 3) return usageError(`"${verb}" requires a new name, e.g. candlestix <id|name> ${verb} <new-name>`);
    if (positionals.length > 3) return usageError(`"${verb}" takes exactly one new-name argument; got extra: ${positionals.slice(3).join(" ")}`);
    const disallowed = rejectDisallowedFlags(flags, {}, verb);
    if (disallowed) return { ok: false, error: disallowed };
    return { ok: true, command: { kind: "rename", idOrName, newName: positionals[2] as string } };
  }

  return usageError(`unknown verb "${verb}"`);
}
