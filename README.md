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
`SIGINT` / `SIGTERM` — it does not yet keep any agents alive. Two pieces of
it exist now: `src/roster.ts` can parse and validate a roster file, and the
health/heartbeat components described below are built. Neither is wired into
the entrypoint, because the supervisor loop that would call them — reading a
roster from disk, spawning agents, recording heartbeats — is a separate,
later story.

## Health (`src/health/`)

Four modules, each with its own doc comment as the primary source of truth —
this section is a map to them, not a replacement for reading them.

- **`heartbeat.ts`** — `createHeartbeatStore()`, an in-memory store of
  `subjectId -> last heartbeat`. **The supervisor contract**: call
  `recordHeartbeat(subjectId)` WHEN, AND ONLY WHEN, a cycle for that subject
  has genuinely completed — never on cycle start, never because no error was
  thrown, never because the process is merely still running. This is the
  fix for a real incident: a health endpoint that derived liveness from the
  *absence of an error callback* lied for fourteen hours while its loop was
  silently dead. `registerSubject(subjectId)` separately marks a subject as
  known (e.g. the roster says it should exist) without asserting it is
  healthy — this is what lets "tracked, never completed a cycle" and
  "never tracked at all" stay two different facts (see below).

- **`staleness.ts`** — `evaluateStaleness(lookup, now, thresholdMs)`, a
  **pure** function: no clock read, no filesystem, no I/O, no ambient state.
  Returns a `StalenessVerdict` discriminated union: `healthy`, `stale`, or
  `unknown`. `unknown` is reachable *only* when the store never tracked the
  subject at all — it is not merely nullable or a comment, it is a value the
  compiler forces every caller to exhaust, and there is no code path from an
  untracked lookup to a definite `stale` or `healthy`. This exists because of
  a second real incident: querying a registry about a subject outside its
  scope produced "no recent heartbeat," which a naive two-valued evaluator
  would faithfully — and wrongly — report as the same "stale" a real death
  produces. Default threshold is `DEFAULT_STALENESS_THRESHOLD_MS` = 90
  seconds; reasoning is in the module doc comment (three times an assumed
  ~30s cycle cadence — tolerate one slow cycle, not two — pending a real
  supervisor loop to measure an actual cadence against).
  Boundary rule: an age of exactly `thresholdMs` is `healthy`; staleness
  requires the age to *exceed* the threshold.

- **`alarm.ts`** — `startStalenessAlarm(options)` runs an **independent
  `setInterval`** that evaluates every tracked subject on its own schedule
  and logs at **ERROR** level (the documented floor for "loud" — it surfaces
  in the journal) when one is `stale`. It never fires for `unknown`: an
  alarm that cries wolf for everything it cannot see trains its operator to
  ignore it. The returned `stop()` is the *only* way to clear the timer —
  the timer id lives solely in a closure inside this module, never exposed
  to or reachable from the `HeartbeatStore` interface, so the loop being
  watched has no path back to silence its own alarm. `runAlarmTick` is the
  pure-schedule-free tick logic the unit tests drive directly;
  `scripts/verify-alarm.ts` is what actually proves the timer fires in a
  real process (see below — this is deliberately not something a unit test
  alone can prove).

- **`signal.ts`** — `buildHealthSnapshot` (pure) plus `writeHealthSignal`
  (atomic file write: temp file + `rename`, so a reader never observes a
  half-written signal) and `startHealthSignalWriter` (puts it on its own
  timer). **A file, not a network port, by design**: a host here can run
  more than one daemon under different Unix users, and a guessed port that
  answers is a *real* answer from the *wrong* daemon — the same failure as
  the registry incident above, made trivial to hit by a port. The written
  JSON states its own scope explicitly (`scope.statement`, plus `host` and
  `pid`) so a reader can tell "this signal never watched that subject" apart
  from "this signal watched it and it's stale" — a subject absent from
  `subjects` was never observed, full stop; it never appears as a
  fabricated `stale` entry.

### Proving the alarm actually fires

A unit test asserting a mock callback was called cannot prove a real timer
fires in a real process, or that a real untracked subject produces real
silence rather than a swallowed error — this repo already rejected one PR
for a capability that read as correct and could not actually run. So:

```sh
bun run scripts/verify-alarm.ts
# or, to control timing:
THRESHOLD_MS=500 ALARM_INTERVAL_MS=200 RUN_MS=2000 bun run scripts/verify-alarm.ts
```

What it does and what to expect, in both directions:

1. Records exactly one heartbeat for a tracked subject, then none again.
   **Expect**: real `ERROR`-level log lines naming it `STALE`, appearing on
   the alarm's own schedule partway through the run, with nobody polling.
2. Never registers or heartbeats a second subject at all. **Expect**: that
   subject's name never appears in any log line, and never appears as an
   entry in the health signal file (its path is printed at startup) — its
   absence *is* the correct, honest answer; a fabricated `stale` entry for
   it would be the registry-incident bug reproduced.
3. The process exits on its own once both timers are stopped — there is no
   `process.exit()` call anywhere in the script. A hang, or an exit before
   ever logging, would mean one of the two capabilities is fake.

## Intended layout

The entrypoint (`src/index.ts`) is kept deliberately small so that each of
the following can be added as a new module plus a couple of wired-in calls,
rather than a rewrite:

- **Roster** — the source of truth for which agents should exist and how to
  reach them, replacing the JQL-query-based discovery `butchr` uses. The
  format and a pure parser/validator exist (`src/roster.ts`, documented
  below); reading the file from disk and acting on it is not wired in yet.
- **Health** — see `src/health/` above. Built ahead of the supervisor loop
  that will call it; the seam is the `recordHeartbeat`/`registerSubject`
  contract documented there.
- **Supervisor loop** — reconciles the roster against reality: starts
  missing agents, detects drift, restores after a machine reboot, and is
  the thing that will actually call `recordHeartbeat` at the end of each
  completed cycle.

`src/log.ts`, `src/health/`, and `src/roster.ts` are the pieces that already
exist ahead of the supervisor loop — pure logic proven by real unit tests in
`test/unit/`, ready for the supervisor to call into once it exists.

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
