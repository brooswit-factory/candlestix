# candlestix

A daemon that manages always-on, very-long-lived **specialty agents**. It
starts when the machine starts, runs in the background, and keeps blank
agents alive. An operator attaches a terminal to one and tells it what to do
— setting up MCP servers, giving it a role — and the daemon's job is just to
keep that agent alive and restore it correctly across restarts.

candlestix is deliberately **not rigid**. It does not know what roles exist.
The role lives in the conversation an operator has with an agent, not in the
product — there is no director type, no watcher type, no built-in taxonomy
of agent kinds. Whether one agent ends up directing others is a choice an
operator makes in conversation, not something candlestix models.

candlestix is role shaped, not ticket shaped: an agent here is born from a
job description, not a Jira issue, has no query that discovers it, and has
no "Done." That is the whole reason it is a separate product from `butchr`
(which is ticket shaped end to end) rather than a mode of it.

## Status

Foundation stage. This repo currently has a scaffold and a minimal
entrypoint that starts up, logs, stays running, and shuts down cleanly on
`SIGINT` / `SIGTERM` — it does not yet keep any agents alive. `src/roster.ts`
can parse and validate a roster file, but nothing loads one from disk or
spawns anything from it yet; the health/heartbeat components and the
supervisor loop that actually make this a daemon are separate, later
stories.

## Intended layout

The entrypoint (`src/index.ts`) is kept deliberately small so that each of
the following can be added as a new module plus a couple of wired-in calls,
rather than a rewrite:

- **Roster** — the source of truth for which agents should exist and how to
  reach them, replacing the JQL-query-based discovery `butchr` uses. The
  format and a pure parser/validator exist (`src/roster.ts`, documented
  below); reading the file from disk and acting on it is not wired in yet.
- **Health** — an honestly-positive heartbeat per agent (no lying "idle" or
  fake-healthy defaults).
- **Supervisor loop** — reconciles the roster against reality: starts
  missing agents, detects drift, restores after a machine reboot.

`src/log.ts` is the one piece of shared infrastructure that already exists
ahead of those modules — a pure log-line formatter every future module can
call into, proven by a real unit test in `test/unit/`.

## Roster

The roster is the operator-editable file that says which agents should
exist. It lives at `$XDG_CONFIG_HOME/candlestix/roster.yaml`, falling back
to `~/.config/candlestix/roster.yaml` when `$XDG_CONFIG_HOME` is unset —
that is a documented convention only; nothing in this repo yet resolves that
path, reads the file, or watches it for changes. An operator adds, edits, or
removes an agent by editing that one YAML file directly; there is no second
file to keep in sync, because the job description lives inline in the
roster rather than as a path to a sibling file.

`src/roster.ts` exports a pure function, `parseRoster(source: string):
ParseRosterResult`, that turns the text of a roster file into a typed
result. It touches no filesystem, environment, clock, or network — call it
with a string and it always returns the same thing. It parses YAML with
Bun's built-in `Bun.YAML.parse` (verified on Bun `1.3.14`: it exists, a `|`
block scalar round-trips with its newlines intact, and malformed input
throws a `SyntaxError` that `parseRoster` catches rather than letting
propagate), so this repo still has zero runtime dependencies.

```ts
type ParseRosterResult =
  | { ok: true; roster: Roster }
  | { ok: false; errors: RosterError[] };
```

It never throws for invalid input — a hand-edited file being wrong is the
expected case, not an exception — and it collects every error it finds
rather than stopping at the first, so an operator can fix a roster in one
pass. `Roster`, `RosterAgent`, `RosterError`, and `ParseRosterResult` are
all exported for later stories to build on.

### Format

```yaml
agents:
  - name: release-notes
    # `job` is the brief handed to the agent. Written as a block scalar (|)
    # so multi-line prose keeps its line breaks instead of being escaped
    # into one line.
    job: |
      Watch this repo's merged PRs and keep a running draft of release
      notes, grouped under Added / Changed / Fixed.
    cwd: /home/operator/code/brooswit-factory/candlestix
    mcpServers:
      github:
        command: npx
        args: ["-y", "@modelcontextprotocol/server-github"]
        env:
          GITHUB_TOKEN: "${GITHUB_TOKEN}"
```

Top level is a mapping with exactly one key, `agents`, whose value is a list
of agent entries. `agents: []` is a valid roster with zero agents. Each
entry has exactly four required fields, with no defaults:

- **`name`** — non-empty string matching `^[a-z0-9][a-z0-9._-]*$`, and
  unique across the roster. It is a durable identifier a later story uses to
  name a session and a working area, so slashes, whitespace, and a leading
  dash are rejected rather than tolerated.
- **`job`** — non-empty (after trimming) string: the brief handed to the
  agent.
- **`cwd`** — non-empty string that starts with `/`. The parser only
  checks the *shape* of the value — that it is an absolute path — never
  that the directory exists; it is pure and does not touch the filesystem.
  Whatever wires the roster into a supervisor is responsible for checking
  the path actually exists at spawn time.
- **`mcpServers`** — a plain object mapping server name to server config.
  Write `{}` explicitly when an agent has no MCP servers; the field is
  required, not omittable, so an empty roster entry and an unset one can't
  be confused.

candlestix does not know what roles or agent "kinds" exist — there is no
`type` or `role` field, and none is planned. The job description in the
roster is the only place a role lives.

An entry with a key outside those four (e.g. a typo like `cwdd`) is
rejected, naming both the entry and the offending key — a silently-ignored
typo would otherwise look to the operator like it worked.

### MCP server validation

The contents of `mcpServers` are passed through to another program (a
Claude Code agent) that owns its own schema, so candlestix does not reject
unknown keys inside a server config the way it does for the four top-level
agent fields — that would force a candlestix release for every upstream MCP
feature. It still validates the shape enough to catch a genuinely broken
config:

- `mcpServers` itself must be a plain object. A list, string, or `null` is
  rejected.
- Each server config must be a plain object, and must be identifiable as
  *some* kind of server: a non-empty string `command` (a stdio server) or a
  non-empty string `url` (an http/sse server). Neither `command` nor `url`
  is required to also be present — a real http/sse config with only `url`
  is valid.
- If present, `args` must be an array of strings, and `env` must be an
  object whose values are all strings.
- Everything else in a server config passes through untouched.

### Other validation rules

- Source that is empty or whitespace-only is rejected.
- The `agents` key must be present and must be a list; anything else is
  rejected with a message saying what was expected.
- Unknown keys at the top level (alongside `agents`) are rejected.
- Malformed YAML is caught and reported as `ok: false`; `parseRoster` never
  throws.

Each `RosterError` names the offending entry (by index, and by name when
the name itself is known and valid) and field where applicable, with a
message that stands on its own without the caller reformatting it.

## Tooling

Bun as the runtime, package manager, and test runner (`bun test`), with
TypeScript in strict mode and `tsc --noEmit` as the typecheck gate. This
matches every other repo in `brooswit-factory` — none of them use a linter,
so this repo doesn't either; strictness comes from `tsconfig.json` instead
(`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`noImplicitOverride`).

## Commands

```sh
bun install --frozen-lockfile   # install deps
bun run typecheck               # tsc --noEmit
bun test                        # run the test suite
bun run build                   # bundle src/index.ts to dist/
bun run start                   # run the entrypoint directly, unbundled
bun run check                   # typecheck + test + build, in that order
```

## CI

`.github/workflows/ci.yml` runs `typecheck`, `test`, and `build` on every
push, pull request, and manual dispatch.
