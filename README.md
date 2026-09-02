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

The supervisor loop is wired up end to end: candlestix reads the roster from
its resolved on-disk path, keeps one blank agent alive per entry (spawning a
missing one, re-adopting one that is already running, and never re-spawning
one that just already exists), wires health honestly per the heartbeat
contract below, and installs as a systemd user unit that starts at boot. See
"Supervisor loop" and "Restart survival" below for what that means and what
was and was not verified.

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
  produces. `DEFAULT_STALENESS_THRESHOLD_MS` (90s) is this module's own
  placeholder, documented as a starting point pending a real cadence; the
  supervisor loop (below) computes its own threshold from its own real
  interval instead of importing this constant — see `src/index.ts`.
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
  fabricated `stale` entry. Path: `$XDG_RUNTIME_DIR/candlestix/health.json`
  (see "XDG paths" below) — printed at startup.

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

The supervisor loop below is a second, live instance of the same proof: see
"Demonstrations" for a real run where the alarm fires honestly during the
genuine startup window before the first cycle completes, then falls silent
once a real heartbeat lands.

## Roster

The roster is the operator-editable file that says which agents should
exist. It is resolved from `$XDG_CONFIG_HOME/candlestix/roster.yaml`,
falling back to `~/.config/candlestix/roster.yaml` when `$XDG_CONFIG_HOME`
is unset **or empty** (`src/xdg.ts`, `src/paths.ts`) — re-read fresh at the
start of every reconcile cycle, so an operator can edit the roster in place
without restarting the daemon. An operator adds, edits, or removes an agent
by editing that one YAML file directly; there is no second file to keep in
sync, because the job description lives inline in the roster rather than as
a path to a sibling file.

**Removing an entry from the roster does not stop the agent it named.**
candlestix only ever starts, adopts, and health-checks agents that are
*currently* in the roster; an agent whose entry was deleted simply stops
being tracked (no more heartbeat, no more health-signal entry) but is left
running exactly as it is — the same "never tear an agent down without being
told to" principle "Restart survival" below is built on. Stopping an agent
on purpose is an operator action (`claude stop <id>`, see "Spawning agents"),
not something removing a roster line does implicitly.

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
all exported for later stories to build on. `src/roster-source.ts` is the
thin impure wrapper that reads the resolved path and calls `parseRoster`; a
missing file is reported as an error (not silently treated as zero agents),
so a typo'd path is distinguishable from a deliberately empty roster.

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
  agent via `--append-system-prompt` at spawn time (see "Spawning agents").
- **`cwd`** — non-empty string that starts with `/`. The parser only checks
  the *shape* of the value at parse time — that it is an absolute path —
  never that the directory exists; existence is checked fresh, at spawn
  time, every cycle (see "Supervisor loop"). A `cwd` that does not exist is
  a clear, per-entry failure — logged loudly, no agent spawned for that
  entry, every other entry unaffected.
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

## Supervisor loop (`src/supervisor.ts`, `src/reconcile.ts`)

Every `RECONCILE_INTERVAL_MS` (20s — see `src/index.ts` for the reasoning),
candlestix loads the roster fresh and, for every entry, decides one of four
actions (`src/reconcile.ts`'s `decideReconcileAction`, a **pure** function —
no fs, no child_process, no clock read, tested directly in
`test/unit/reconcile.test.ts` against every branch below without mocking
anything):

- **`heartbeat`** — a live agent for this entry was found and *independently
  verified*, per the heartbeat contract in `health/heartbeat.ts`.
- **`spawn`** — no agent for this entry exists anywhere candlestix can see,
  and its `cwd` exists. Launch a fresh one (see "Spawning agents").
- **`wait`** — an agent is listed for this entry but candlestix could not
  independently verify it is alive *this cycle*. No heartbeat, no spawn —
  just wait for the next cycle. See "The false-healthy trap this caught
  for real" below for why this branch exists and is not merely theoretical.
- **`cwd-missing`** — no agent exists and the entry's `cwd` does not exist
  either. Logged loudly, this entry only, every other entry unaffected.

**"Found" and "independently verified" are two different checks, on
purpose.** candlestix's primary source for "what agents exist" is `claude
agents --json` (Claude Code's own scriptable listing of its background
sessions — see "Spawning agents" for why this substrate was chosen). But
per this ticket's own guidance — *"if your supervisor asks something else
whether an agent is alive, you have moved the lie rather than removed
it... treat that answer as a hint, not as truth"* — candlestix does not
record a heartbeat on listedness alone. It additionally requires the listed
entry to carry a `pid`, and independently confirms that pid with
`kill(pid, 0)` (`src/proc.ts`) at the same moment the listing was fetched.
Only when both hold does a cycle count as genuinely completed.

### The false-healthy trap this caught for real

While building this, killing a background session's backing process live
(to test crash detection) produced exactly the failure mode this ticket
warns about, unprompted: `claude agents --json` kept listing the session —
same `id`, same `sessionId` — but its `pid` field disappeared for a couple
of seconds while Claude Code's own daemon transparently re-homed it onto a
new backing process. A supervisor that read bare listedness as "alive"
would have recorded a heartbeat for a session with **no verifiable backing
process at that moment** — the exact shape of the fourteen-hour incident
`health/heartbeat.ts`'s doc comment describes, just with a different
upstream source lying about health instead of an absent error callback.

candlestix's `wait` branch is what this looks like when it works: a real
run's log shows

```
WARN "demo-agent": session "8589df43" is listed but claude's daemon
     reported no pid for it this cycle; not recording a heartbeat this cycle
```
followed, once the daemon's self-heal completed and a real pid reappeared and
verified alive, by a resumed heartbeat with no operator action taken. See
"Demonstrations" for the full real log. This is also why
`agents-cli.ts:parseAgentsJson` throws (rather than returning `[]`) on
anything that is not the expected JSON array, and why a listing failure
(`claude agents --json` erroring or timing out — observed live on this busy
multi-agent host, see "Demonstrations") skips heartbeats for **every**
roster entry that cycle rather than guessing: an empty or failed listing
must never be read as "nothing is running," which would risk spawning
duplicates for agents that are, in fact, alive.

### The registry (`src/registry.ts`, `src/registry-store.ts`)

candlestix keeps its own durable record of `roster agent name -> { id,
sessionId, cwd, spawnedAt }` at
`$XDG_RUNTIME_DIR/candlestix/registry.json`. **This registry is bookkeeping
and an operator-visible audit trail — it is explicitly NOT the source of
truth for liveness.** `claude agents --json`, cross-checked against a live
`kill(pid, 0)` at read time, is the source of truth every cycle, always
re-fetched fresh. If the registry file is lost, corrupted, or simply absent
(first run), `decideReconcileAction`'s **adopt-by-cwd fallback** finds any
already-running background session whose `cwd` matches the roster entry and
adopts it instead of spawning a duplicate — the registry is safely
reconstructable from `claude`'s own live state, by construction. This also
means candlestix never carries a pid *across a reconcile cycle*: every
cycle re-asks "what's alive right now" and only ever trusts a pid within
the same instant it was reported, which is a stronger property than the
usual "pid + start-time pairing to catch a recycled pid," not a weaker one
— there is no stale, candlestix-held pid to recycle in the first place.

Written under `$XDG_RUNTIME_DIR` — survives a candlestix restart, not a
reboot — matching this ticket's requirement exactly, since the agents
themselves do not survive a reboot either (see "Restart survival").

## Spawning agents (`src/spawn.ts`)

A fresh blank agent is launched with:

```
systemd-run --user --scope --unit=candlestix-launch-<name>-<random> \
  --collect --expand-environment=no -- \
  claude --bg --append-system-prompt <job> --strict-mcp-config --mcp-config <path>
```

run with the process's `cwd` set to the roster entry's `cwd`.

### Why `claude --bg`, not the hand-rolled `setsid`+`script` pty this ticket's
### own investigation proposed

The ticket's §6 findings (a real investigation, dated the same day this
story was filed) concluded a blank interactive agent needs a real pty,
built by hand with `setsid script -qfc ...`. Re-verifying that live
surfaced a better-fitting, first-class primitive the investigation didn't
cover: **`claude --bg`**, Claude Code's own background-session feature.
Concretely, verified live rather than assumed from `--help` text:

- **No TTY required, at all** — `claude --bg ... < /dev/null` on a sandbox
  with no controlling terminal returns immediately with
  `backgrounded · <id> (idle — send a prompt to start)`. §6 Finding A
  ("no TTY -> falls back to `--print` and exits") tested the bare
  interactive path, not this documented, separate mode.
- **Sidesteps the workspace-trust dialog.** A hand-built pty via
  `setsid script` hits Claude Code's own first-run "do you trust this
  folder?" prompt and blocks there forever with nothing to answer it —
  verified live, this is a real dead end for that approach, not a
  hypothetical. `--bg` does not: `claude --help` documents the trust
  dialog as skipped whenever stdout is not a TTY, which a background
  session's stdout structurally never is, and this was confirmed live (no
  hang, immediate `idle` state).
- **Gives candlestix `claude agents --json` / `attach <id>` / `logs <id>` /
  `stop <id>` for free** — Claude Code's own maintained surface, not
  candlestix's own pty/log-capture code. This is the concrete answer to
  this ticket's "attachable in principle" requirement: **an operator can
  run `claude attach <id>` today, right now, against any agent candlestix
  spawned** (the `id` is in the registry and in `claude agents`). There is
  no candlestix-specific attach *command* — none is needed, since Claude
  Code's own `attach` already does the job — but there is also no
  candlestix convenience wrapper for it yet (e.g. `candlestix attach
  <roster-name>` translating a roster name to a session id); that
  convenience layer is a real, separate seam this story does not build, not
  a hidden gap.

### The cgroup hazard, and where it actually turned out to live

This ticket's §7 flags `KillMode=control-group` (systemd's default) killing
everything in a unit's cgroup on stop/restart as the single most likely
place for a fake restart-survival claim, and asks for empirical
verification rather than trusting the paragraph. That verification found
the hazard one level up from where the ticket describes it: it is not
`claude --bg`'s own process that is at risk (Claude Code's own background
sessions are already children of a long-lived daemon of their own, reparented
away from whatever invoked `--bg`), it's that daemon's **birth cgroup**.

The first-ever `claude --bg` invocation for a Unix user spawns a singleton
process (`claude daemon run`) that every subsequent `--bg` session on the
host shares, and — verified by inspecting its `/proc/<pid>/cgroup` live —
it inherits whatever cgroup its first invoker happened to be running in.
Had candlestix's own systemd service happened to be that first invoker, a
later `systemctl --user restart candlestix` would SIGTERM that cgroup and
take the shared singleton down with it — and by extension **every**
background Claude Code session on the host, not just candlestix's own, not
only this one agent.

`systemd-run --user --scope` around every launch is what avoids this: it
moves the invocation (and, if it is the first ever, the singleton daemon it
gives birth to) into its own independent, sibling cgroup under `app.slice`
*before* candlestix's own service cgroup ever contains it. Verified live,
under the real systemd unit (not just an ad-hoc process): a spawned agent's
`/proc/<pid>/cgroup` reads
`.../app.slice/candlestix-launch-demo-agent-<random>.scope`, never
`.../app.slice/candlestix.service` — see "Demonstrations" for the
restart test that depends on this and passed.

`--expand-environment=no` is explicit, not left to the (current) default:
`systemd-run` warns that a command line containing `$something` is "not
expanded by default for now, but will be expanded by default in the
future." An operator's job description is exactly the kind of free text
that could contain a literal `$VAR`-looking sequence; pinning the flag
makes today's non-expanding behaviour permanent regardless of that future
default change.

**Argv is never built as a shell string.** Every invocation goes through
`src/exec.ts`'s `runCommand`, which calls `Bun.spawn` with an argv array —
the job description, the mcp config path, everything, each its own array
element, handed to `execve` directly. No `/bin/sh -c`, anywhere in the
launch path, ever sees roster-derived text. An operator's job description
containing quotes, `$`, backticks, or newlines needs no escaping and cannot
break the command — verified with exactly such a string in
`test/unit/spawn.test.ts`.

### MCP config and `--strict-mcp-config`

Each agent's `mcpServers` (from the roster) is written to its own file at
`$XDG_RUNTIME_DIR/candlestix/agents/<name>/mcp.json` — **never into the
roster's `cwd`**, which is the operator's own working directory, not
candlestix's. `--strict-mcp-config` is passed so the agent's MCP servers
are *exactly* the roster's declared set — no stray project-level or
user-level MCP config leaking in, keeping what an agent can reach fully
determined by its roster entry.

## Restart survival

**The requirement, as ruled by the epic this story implements (CNDLX-8):
agents OUTLIVE the daemon and are RE-ADOPTED across a `systemctl --user
restart`, never killed and respawned.** The reasoning: candlestix
deliberately knows nothing about roles (see above), so the conversation an
operator has had with an agent *is* that agent's accumulated value — the
only place its role exists in this product. Tearing an agent down on every
daemon restart would destroy exactly what candlestix exists to preserve,
silently, while still passing a naive reading of "the agent came back."

This holds here, and was **verified live under the real systemd unit**, not
assumed:

1. An agent is spawned; its session `id`, pid, and `/proc/<pid>/stat` field
   22 (start time) are recorded.
2. `systemctl --user restart candlestix` (or `candlestix-test` in the
   verification run) is issued — a fresh daemon process comes up with a new
   Main PID.
3. The agent's pid **and its recorded start time are checked again** —
   deliberately both, not just pid existence, because a bare "is this pid
   present" check cannot distinguish a genuinely-surviving process from a
   different, unrelated process that happened to reuse the same pid number
   in between.

Both matched, exactly, in the verification run (see "Demonstrations"). This
works structurally, not by luck: every agent is a `claude --bg` background
session, a process tree that is a child of Claude Code's own persistent
background-session daemon — not of candlestix — and living in its own
`systemd-run --scope`, not candlestix's service cgroup (see "Spawning
agents"). candlestix's shutdown (`src/index.ts`) reflects this directly:
on `SIGINT`/`SIGTERM` it stops its own reconcile-loop timer, its own alarm,
and its own health-signal timer, and does **nothing at all** to any spawned
agent. Their defined fate on shutdown, restart, or a candlestix crash is:
**left running, completely untouched, exactly where they are** — which is
what makes the next startup's re-adoption possible at all.

`src/index.ts`'s old `shutdown()` — approved deliberately back when there
was nothing to drain — called `process.exit(0)` immediately. That is gone;
the replacement is described above and is what "gives spawned agents a
defined fate" concretely means here.

**What this does not cover, honestly, per the escape hatch the epic
attached to this requirement (§7a):** a machine reboot is a different,
separate epic — an agent's process does not, and is not claimed to, survive
that, and the pid registry does not claim otherwise (see "The registry"
above: it lives under `$XDG_RUNTIME_DIR`, which does not survive a reboot).
Re-adoption **did** work end to end on the substrate actually installed
here — this is not a case where the escape hatch had to be invoked to
report a gap, but it is stated because the epic asked for the honest
distinction either way, not an assumption that it would always hold on
every substrate.

## systemd user unit (`systemd/candlestix.service`)

Install as a **user** unit — not a system unit, which is a different thing
with different journal commands (see below):

```sh
mkdir -p ~/.config/systemd/user
cp systemd/candlestix.service ~/.config/systemd/user/candlestix.service
systemctl --user daemon-reload
systemctl --user enable --now candlestix.service
```

The shipped unit's `ExecStart` points at `%h/code/brooswit-factory/candlestix`
— the canonical clone location this ticket's own process document
describes (`~/code/<owner>/<repo>`) — and its `PATH` is set explicitly
(`%h/.bun/bin:%h/.local/bin:/usr/local/bin:/usr/bin:/bin`) because a
systemd user unit's `PATH` is **not** your login shell's, and `bun` in
particular was found off the default `PATH` on the investigated host (this
ticket's own §12).

### `loginctl enable-linger` — starting at boot without a login

A systemd **user** service does not start at boot on its own; it starts
when that user's systemd instance starts, which by default only happens on
login. `loginctl enable-linger <user>` is what makes the user's systemd
instance (and therefore its enabled units) start at boot independent of any
login. **Check whether it is already on**, since it may be for other
reasons:

```sh
loginctl show-user "$(whoami)" -p Linger
# Linger=yes  -> already on, nothing to do
# Linger=no   -> loginctl enable-linger "$(whoami)"   (needs root/sudo)
```

### What "starts at boot" actually means here — verified vs. not

This ticket names "starts at boot" as one of the two most likely places in
this whole product for a fake capability, and is explicit that
`systemctl --user is-enabled` is evidence about *enablement*, not about
*boot*. Said plainly:

- **Verified**: the unit installs, `daemon-reload`s cleanly, `enable`s
  (`systemctl --user is-enabled` reports `enabled`), and `start`s under
  real systemd supervision — not just `bun run` — with the expected
  `Main PID`, journal output flowing through `journalctl --user`, and
  (critically for restart survival) a spawned agent living in its own
  sibling cgroup, never the unit's own. `loginctl enable-linger` was
  already `yes` on the host this was verified against.
- **Not verified**: an actual host reboot. This host runs a live, shared
  fleet of many other agents' in-progress work; rebooting it was out of
  proportion to what this ticket needs and was not attempted. What *is*
  verified — enablement plus linger plus the systemd semantics those two
  combine to produce — is the standard, well-documented mechanism by which
  a `WantedBy=default.target` user unit starts at boot; this is stated as
  "the mechanism is verified to be correctly wired," not as "a reboot was
  observed to work," and the two are being kept honestly distinct rather
  than the first quietly standing in for the second.

### `journalctl` — the sharp edge that looks like an empty log, not an error

For a systemd **user** unit, the **system-level** `journalctl -u <unit>`
(no `--user`) prints `-- No entries --` — not a permission error, not any
other signal that the command was wrong. It looks exactly like an empty
log. The correct invocation for candlestix's own unit:

```sh
journalctl --user -u candlestix.service
journalctl --user -u candlestix.service -f   # follow
```

(Do not confuse this with `butchr.service` or `herdr.service` — the
investigated host already runs both, as user units, and they are different
processes from candlestix entirely. Every `journalctl`/`systemctl` command
above targets `candlestix.service` specifically.)

## XDG paths (`src/xdg.ts`, `src/paths.ts`)

| What | Path | Survives |
|---|---|---|
| Roster (operator-edited, read-only to candlestix) | `$XDG_CONFIG_HOME/candlestix/roster.yaml`, falling back to `~/.config/candlestix/roster.yaml` | reboot |
| Registry | `$XDG_RUNTIME_DIR/candlestix/registry.json` | daemon restart, not reboot |
| Health signal | `$XDG_RUNTIME_DIR/candlestix/health.json` | daemon restart, not reboot |
| Per-agent MCP config | `$XDG_RUNTIME_DIR/candlestix/agents/<name>/mcp.json` | daemon restart, not reboot |

`XDG_CONFIG_HOME`/`XDG_STATE_HOME`/`XDG_RUNTIME_DIR` set to the **empty
string** are treated identically to unset (`src/xdg.ts`, unit-tested) — a
real case on some systems, not a hypothetical, per this ticket. When
`XDG_RUNTIME_DIR` is unset or empty, candlestix falls back to a
uid-scoped subdirectory of the OS tmpdir (`src/paths.ts`); this has weaker
durability guarantees than a real `XDG_RUNTIME_DIR` (most tmpdirs are also
reboot-cleared, which is fine, but are not guaranteed stable across every
daemon restart the same way) and is documented here as a fallback, not
presented as equivalent. `XDG_RUNTIME_DIR` was set
(`/run/user/<uid>`) and `XDG_STATE_HOME` was unset on the host this was
verified against — both cases this table's fallback column depends on are
real, not hypothetical, on the actual target host.

## Known gaps — stated plainly, not implied away

- **No candlestix-specific attach convenience.** `claude attach <id>` /
  `logs <id>` / `stop <id>` work today against any agent candlestix
  spawned (see "Spawning agents"); a `candlestix`-side command that
  translates a roster *name* to its current session id is a real,
  separate seam this story does not build.
- **Argv-drift correctness on wake is out of scope** (a separate epic, per
  this ticket). Not observed to be broken during this story's own testing
  — every re-adopted agent's `/proc/<pid>/cmdline` matched its original
  launch argv exactly — but candlestix does not defend against or detect
  drift if it ever occurs.
- **Reboot survival is a separate epic.** An agent's process, and
  candlestix's own registry, do not survive a reboot; only a daemon
  restart is covered (see "Restart survival").
- **Ambiguous adoption**: if two *different* background Claude Code
  sessions happen to share the exact same `cwd`, `decideReconcileAction`'s
  cwd-adoption fallback adopts whichever one `claude agents --json`
  happens to list first. Not defended against further; roster `cwd`s are
  expected to be distinct per agent in practice.
- **Nudge verification, startup-dialog answering (beyond the workspace-trust
  skip `--bg` already gets for free), and session-limit recognition are all
  out of scope**, per this ticket.
- **Boot-at-startup**: the enablement/linger mechanism is verified; an
  actual reboot was not performed on the shared host this was built on.
  See "systemd user unit" above.

## Tooling

Bun as the runtime, package manager, and test runner (`bun test`), with
TypeScript in strict mode and `tsc --noEmit` as the typecheck gate. This
matches every other repo in `brooswit-factory` — none of them use a linter,
so this repo doesn't either; strictness comes from `tsconfig.json` instead
(`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`noImplicitOverride`). Zero runtime npm dependencies, including in this
story's additions — `systemd-run`, `claude`, and `kill(pid, 0)` are shelled
out to / called via Node's own `process.kill`, never installed as packages.

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
push, pull request, and manual dispatch. Note this ticket's own §12 blind
spot: `engines.bun` in `package.json` is `>=1.3.14` (the roster uses Bun's
built-in `Bun.YAML`), but CI pins `bun-version: latest`, so **CI structurally
cannot verify that floor** — a regression against the stated minimum would
pass CI regardless. This was true before this story and remains true after
it; not something this story introduces or fixes.
