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

**CNDLX-33 landed: three defects CNDLX-27's own epic review found in the
daemon API are fixed.** A malformed percent-escape in `{idOrName}`, and
any other unexpected throw on the request path, now return typed JSON
(`malformed-path` 400, `internal-error` 500) — never `Bun.serve`'s default
HTML page (previously true of both). `POST /v1/agents` and `.../rename`
now reject any body that isn't empty-or-an-object-with-only-the-expected-
keys, so a bare string/number/array/`null`, or a typo'd field name, can no
longer mint an agent and spawn a session (`invalid-request-body`, naming
what was wrong). An empty or whitespace-only `job` is refused
(`invalid-job`) rather than reaching spawn as `--append-system-prompt ""`
(R3). See "The daemon API" and "Demonstrations — CNDLX-33" below.

**CNDLX-32 landed: the daemon exposes the whole action set over a local
Unix socket.** The eight-verb lifecycle action set, `attach-target` (R18's
query), and the `open-terminal` seam are all reachable over HTTP-over-a-
Unix-domain-socket — see "The daemon API" below for the transport
reasoning, the route table, and the demonstration. The CLI (CNDLX-28) is
being built in parallel against this exact contract; the webapp (CNDLX-16)
comes after. `open-terminal` itself is still an honest seam — CNDLX-3
implements actually opening a window.

**CNDLX-19 landed: the reconcile loop is desired-state driven, and the
roster is retired.** candlestix now reads only the durable, daemon-owned
agent set (`$XDG_STATE_HOME/candlestix/agents.json` — see "The durable
agent set" below) to decide what should be alive. An agent recorded `off`
or `archived` is never spawned, by any path, ever — the bug this story
fixes is described in detail under "Supervisor loop" below. The roster
file and every roster-driven code path (parser, loader, spawn path,
name-keyed per-agent MCP config) are deleted, not merely unused; see
"Legacy roster file (retired)".

The full eight-verb lifecycle action set (`create`/`on`/`off`/`rename`/
`archive`/`unarchive`/`delete`/`list`, `src/agent-actions.ts`) has two
consumers: the reconcile loop reads exactly the state these verbs write,
and the daemon API (`src/api/`) is the one process that calls them to
mutate it.

**CNDLX-31 lands: the `candlestix` CLI now speaks the real, merged daemon
API contract.** CNDLX-30 (a predecessor task) added the CLI — grammar, a
thin HTTP-over-Unix-socket client, in-place attach, a confirming delete,
exit codes — built against a temporary, local restatement of CNDLX-27's
contract (`src/api-contract.ts`) because CNDLX-27 had not merged yet. That
temporary file is now gone; the CLI imports `src/api/contract.ts`, the
real, merged contract module, directly — including its `apiSocketPath`
resolver, so the CLI and the daemon it talks to derive the socket path
from the same function. See "The candlestix CLI" below for what shipped
and the real end-to-end demonstration against a real daemon and a real
`claude --bg` session. No webapp yet (CNDLX-16); the daemon-opens-a-window
form of attach is still not built (CNDLX-3).

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
  silently dead. `registerSubject(subjectId, displayName?)` separately marks
  a subject as known (its recorded state is `on`) without asserting it is
  healthy — this is what lets "tracked, never completed a cycle" and
  "never tracked at all" stay two different facts (see below). **CNDLX-19
  T3/T4**: `subjectId` is the agent's durable **id**, never its mutable
  name — a name is carried only as an optional `displayName`, purely for a
  human reading the health signal, and is never matched or keyed against
  anywhere in this store. `unregisterSubject(subjectId)` (new in CNDLX-19)
  removes a subject entirely and is idempotent; **only `on` agents are
  ever subjects**, and an agent that leaves `on` (turned off, archived, or
  deleted) is unregistered the very next cycle — see "Supervisor loop"
  below for why this matters (an unbounded permanently-stale row is a real
  regression, not a cosmetic one).

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
  ignore it. Combined with `heartbeat.ts`'s `unregisterSubject` (above),
  turning an agent off silences its alarm rather than leaving it stale
  forever — the product's one real "an operator needs to look at this"
  signal stays meaningful. The returned `stop()` is the *only* way to clear
  the timer — the timer id lives solely in a closure inside this module,
  never exposed to or reachable from the `HeartbeatStore` interface, so the
  loop being watched has no path back to silence its own alarm. `runAlarmTick`
  is the pure-schedule-free tick logic the unit tests drive directly;
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
  fabricated `stale` entry. Each subject entry also carries `agentName`
  (CNDLX-19 T4) — the id alone is durable but illegible; the name rides
  along for a human, and is `undefined` for a blank agent, never a key.
  Path: `$XDG_RUNTIME_DIR/candlestix/health.json` (see "XDG paths" below) —
  printed at startup.

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

## Legacy roster file (retired — CNDLX-19 / R12)

Before CNDLX-19, candlestix read an operator-edited roster file
(`$XDG_CONFIG_HOME/candlestix/roster.yaml`) as the source of truth for
which agents should exist. **That file is no longer read by any code path
in this tree.** The parser (`src/roster.ts`), its impure loader
(`src/roster-source.ts`), the roster-driven spawn path (`src/spawn.ts`),
and the name-keyed legacy per-agent MCP config function CNDLX-18
quarantined for this retirement (`legacyRosterMcpConfigPath`) are all
**deleted**, along with their tests and the example roster
(`examples/roster.yaml`) — not merely unused, gone.

**Why this overturns a recorded project decision, deliberately.** The
CNDLX project root doc's 2026-09-02 decision was *"the roster, not a
query, is the source of truth for what agents exist."* That premise held
while creating, renaming, archiving, and deleting an agent were things an
operator did by hand-editing a file. It stopped holding once CNDLX-18
shipped those as **daemon actions** (`src/agent-actions.ts`): once the
daemon writes the agent set itself, a hand-edited file sitting alongside
it is a second source of truth that will silently disagree with the
first. An import path from a legacy roster into the daemon-owned set is
CLI-shaped work that belongs to CNDLX-15 if the human ever wants it;
building it here was explicitly out of this epic's scope.

**What happens if a legacy roster file still exists on disk.** It is
**ignored, loudly** — not silently migrated (silent migration of a file
the operator believes is authoritative would produce agents nobody asked
for and hide that it did — the worst of the three options), and not
refused-to-start (refusing to boot over a stale file an operator forgot
about would turn an accident into an outage). Concretely, `src/index.ts`
stats `legacyRosterPath()` (`src/xdg.ts`/`src/paths.ts` — the ONE function
kept from the retired roster module, renamed to say what it is now for: a
legacy path, referenced only by this warning, never a live input) once at
startup. If the file exists, it logs one clear line naming the file's
**full path**, saying it is no longer read, and saying what to do instead
— **once per daemon start, never once per cycle**, since a warning
repeated every 20 seconds is noise, and noise is how real warnings get
filtered out. If the file does not exist, nothing is logged — warning
about a file that is not there would itself be exactly that noise. See
"Demonstrations" below for a real run showing this warning fire exactly
once across two full reconcile cycles.

## Supervisor loop (`src/supervisor.ts`, `src/reconcile.ts`)

**CNDLX-19: the loop is desired-state driven.** Every
`RECONCILE_INTERVAL_MS` (20s — see `src/index.ts` for the reasoning),
candlestix loads the durable agent set fresh (`loadAgentSet`,
`src/agent-set-store.ts` — CNDLX-17) and, for every agent it contains,
decides one of six actions (`src/reconcile.ts`'s `decideReconcileAction`, a
**pure** function — no fs, no child_process, no clock read, tested
directly in `test/unit/reconcile.test.ts` against every branch below,
exhaustively over the state axis, without mocking anything):

- **`heartbeat`** — a live session for an `on` agent was found and
  *independently verified*, per the heartbeat contract in
  `health/heartbeat.ts`.
- **`spawn`** — an `on` agent has no live session anywhere candlestix can
  see, and its directory exists. Launch a fresh one (see "Spawning
  agents"). **This is the only action type that ever launches a session,
  and it is reachable only when `state === "on"`** — the bug this story
  fixes is that the pre-CNDLX-19 version of this function had no state
  input at all and reached an equivalent branch unconditionally.
- **`wait`** — an `on` agent has a session listed but candlestix could not
  independently verify it is alive *this cycle*, OR more than one live
  session matches its directory exactly with no registry match to break
  the tie (T5 — see below). No heartbeat, no spawn, no guess — just wait
  for the next cycle.
- **`dir-missing`** — an `on` agent has no live session and its directory
  does not exist either. Logged loudly, this agent only, every other agent
  unaffected.
- **`not-subject`** — an `off` or `archived` agent with no live session
  under its directory. This is the expected, quiet steady state: nothing
  to do, nothing to log.
- **`unexpected-session`** — an `off` or `archived` agent **with** one or
  more live sessions running under its directory anyway. See "Off/archived
  with a stray session" below — this is a report-only action; the loop
  never stops or removes anything.

### The bug this story fixes, precisely

Before CNDLX-19, `ReconcileInputs` had no state field of any kind, and the
last statement of `decideReconcileAction` was an unconditional
`return { type: "spawn" }`, reached whenever nothing was found and the
directory existed — regardless of whether an operator had just turned that
agent off. The human's own framing of the bug:

> "Off" is a recorded intention, not merely an absence; a supervisor that
> helpfully restarts an agent the operator turned off is the bug this
> bullet exists to prevent.

CNDLX-18 gave the operator an off switch (`turnOff`, `src/agent-actions.ts`)
that stops the session. Before this story, the supervisor loop had no
concept of that switch at all and would cheerfully undo it on the very
next 20-second cycle. `state`, read fresh from the durable agent set every
cycle, is the fix: `off` and `archived` never reach `spawn`, by
construction — see the exhaustive `state !== "on"` tests in
`test/unit/reconcile.test.ts`.

### The loop is SPAWN-ONLY — it never stops or removes a session

`off`/`archived` mean "do not spawn." They do **not** authorise the loop
to kill anything — there is no action type in `ReconcileAction` that means
"stop this session." When a live session is found under an `off` or
`archived` agent's directory anyway, the loop reports the disagreement
loudly and takes no action on the session (`unexpected-session`, above).
Three reasons, all load-bearing:

- **The cgroup hazard is the single most likely way this product breaks
  the host, and this loop would trip it automatically, on a timer, with
  nobody watching.** The first `claude --bg` invocation for a Unix user
  spawns a long-lived `claude daemon run` singleton that every later
  `--bg` session on the host shares, inheriting the cgroup of its first
  invoker (see the comment in `src/agent-spawn.ts`). A loop that kills a
  cgroup on a timer takes down every background Claude session on the
  machine, including other people's. `turnOff` and `deleteAgent`
  (`agent-actions.ts`) already avoid this by issuing only `claude stop`/
  `claude rm` per session, never touching a cgroup or a systemd scope —
  but a periodic, unattended loop is exactly the kind of code that
  eventually reaches for something blunter. The loop simply never gets
  the chance: it has no verb that stops anything.
- **The loop cannot distinguish "off, with a stray session" from "the
  `off` record is stale because a store write failed right after a
  start"** (see "What the loop does when the record disagrees with
  reality" below). Stopping there could destroy a session an operator may
  have just created; not stopping costs one visible, logged, recoverable
  anomaly. The asymmetry is decisive.
- **`turnOff` already stops the session.** The loop's job is to not undo
  the operator's intention, not to re-enforce it on a timer.

The report itself is deduplicated: `decideReconcileAction` reports the
same fact every time it is asked (it is pure — no memory across calls),
but `src/supervisor.ts` keeps a `Map<agentId, signature>` of the last
warning issued per agent, threaded across cycles by `src/index.ts`, and
only logs again when the set of offending session ids actually changes —
a warning repeated every 20 seconds for an unchanged condition is noise,
and noise is how real warnings get filtered out. See "Demonstrations"
below for a live run showing exactly one warning across two consecutive
cycles for an unresolved stray session.

### Adoption keys on the directory, which is derived from the id

`src/agent-directory.ts` (CNDLX-18) derives every daemon-created agent's
directory from its minted id: `$XDG_STATE_HOME/candlestix/agents/<id>/`.
Two named ambiguities CNDLX-1 recorded for the pre-CNDLX-19 roster world:

- **"Two entries sharing a directory" (both adopt the same session,
  neither spawns) disappears for free — scoped to candlestix's own
  minted-directory model, not as a general claim.** Confirmed, not
  merely assumed: `guardAgentDirectoryRemoval` and every path in
  `src/xdg.ts`/`src/agent-directory.ts` derive an agent's directory as a
  pure join of its **minted** id under a base directory candlestix itself
  owns, and nothing in this tree ever accepts an operator-supplied
  directory for an agent. Because candlestix mints the id AND owns the
  directory namespace it is derived from, two agents cannot share a
  directory — it is structural, not conventional. **This claim is
  deliberately scoped to that precondition, not stated as "unique ids fix
  directory-keyed adoption" in general**: a sibling project (bakr) runs
  agents in directories that are *given*, not minted — several agents per
  directory is its headline feature, not an edge case — and its root doc
  binds it to never resolve, adopt, or reconcile an agent by directory
  alone. The distinguishing property is **who owns the directory
  namespace**: where the daemon mints the leaf from an id it owns
  (candlestix), one-directory-one-agent is structural; where the directory
  is given (bakr), it is not, and directory-keyed adoption there would be
  unsound. A future shared substrate, if one is ever built, must carry
  bakr's stricter invariant, not candlestix's looser one.
- **"Two live sessions sharing one directory" does NOT disappear**, and is
  not silently resolved by taking the first match. `src/agent-session.ts`'s
  own rule for *stopping* a session is "every exact match" (CNDLX-18); that
  rule has no meaning for *adoption* (you cannot adopt two). So
  `decideReconcileAction` does not invent a competing rule either: when
  more than one live session matches an `on` agent's directory exactly and
  none matches the registry, the action is `wait` — report, never guess,
  never spawn a duplicate next to an ambiguous pair. `claude`'s own
  `--cwd` filter is documented as a **prefix** match, not an exact one; the
  exact-match filter is applied client-side, in `src/reconcile.ts` and
  `src/agent-session.ts` alike.

### What the loop does when the record disagrees with reality

`agent-actions.ts`'s verbs return a typed `store-write-failed` when the
durable write fails *after* the session effect already happened — so an
agent's recorded state can, in principle, be stale relative to a session
that was just started or stopped. **The loop's ruling: it obeys the
recorded state, always, with no heuristic override.** The recorded state
*is* the desired state; a failed write means the intention was never
recorded, and the operator was told so by a typed error at the moment it
happened. A loop that infers intention from observed liveness would make
liveness authoritative over the record — precisely the confusion this
story exists to remove. What the loop owes instead is **visibility**: when
`state` and what `claude agents --json` shows disagree, that surfaces as
an ordinary `wait` (state `on`, nothing verifiably alive) or
`unexpected-session` (state `off`/`archived`, something alive anyway) —
never as this function second-guessing which one to believe. `decideOn`/
`decideOff`'s own "no-change is a success, not a repair" rule
(`agent-lifecycle.ts`) means the loop's honesty here is not undermined by
the action layer quietly overwriting a disagreement either.

### The registry (`src/registry.ts`, `src/registry-store.ts`)

candlestix keeps its own durable record of `agent id -> { sessionShortId,
sessionId, cwd, spawnedAt }` at `$XDG_RUNTIME_DIR/candlestix/registry.json`.
**This registry is bookkeeping and an operator-visible audit trail — it is
explicitly NOT the source of truth for liveness.** `claude agents --json`,
cross-checked against a live `kill(pid, 0)` at read time, is the source of
truth every cycle, always re-fetched fresh. If the registry file is lost,
corrupted, or simply absent (first run), `decideReconcileAction`'s
**adopt-by-directory fallback** finds any already-running background
session whose `cwd` matches the agent's own directory and adopts it
instead of spawning a duplicate — the registry is safely reconstructable
from `claude`'s own live state, by construction.

**CNDLX-19 T4 (H1) — re-keyed from the agent's mutable name to its durable
id.** Before this story, this file was keyed by a roster agent's `name`;
CNDLX-18 found and reported this (rather than fixing it, correctly, since
it lived in exactly the modules this story rewrites) as the same bug class
as R16's per-agent-MCP-config fix. The test CNDLX-18 applied throughout,
inherited here: *does a rename cost durable data, or one recoverable
cycle?* This one is the second kind — the registry is ephemeral and
reconstructable from `claude`'s own live state — so it is fixed by simply
re-keying the live shape rather than migrating the old one. A name is
still carried, as `agentName` — a **display field only**, never a key,
never matched against by `decideReconcileAction` or anything else in this
tree.

**A pre-CNDLX-19, name-keyed file on disk (version 1) is recognised as
LEGACY, distinct from malformed, and discarded honestly.** The old parser
accepted only `version: 1`; anything else was "malformed." A legacy file
is perfectly well-formed *for its own, previous version* — calling it
malformed would send an operator hunting for corruption that does not
exist. `parseRegistry` (`src/registry.ts`) now distinguishes the two: a
`version: 1` file whose entries match the exact old
`{name, id, sessionId, cwd, spawnedAt}` shape is reported as `legacy`;
anything else that fails to parse is `malformed`. `loadRegistry`
(`src/registry-store.ts`) logs a distinct message for each — "superseded,
discarding, self-heals this cycle" for legacy; "malformed, starting from
empty" for genuine corruption — and both fall back to an empty registry,
which is correct here (unlike the durable agent set — see below) because
this file is reconstructable from nothing but `claude`'s own live state.

Written under `$XDG_RUNTIME_DIR` — survives a candlestix restart, not a
reboot — matching the sessions themselves, which do not survive a reboot
either (see "Restart survival").

## Spawning agents (`src/agent-spawn.ts`)

**The daemon-agent spawn path (`spawnDaemonAgent`, CNDLX-18) is the only
spawn path left** — the roster-driven one (`src/spawn.ts`,
`spawnBackgroundAgent`) is deleted along with the roster. A fresh blank
agent is launched with:

```
systemd-run --user --scope --unit=candlestix-launch-<id-without-@>-<random> \
  --collect --expand-environment=no -- \
  claude --bg [--append-system-prompt <job>] --strict-mcp-config --mcp-config <id-keyed path>
```

run with the process's `cwd` set to the agent's own directory
(`$XDG_STATE_HOME/candlestix/agents/<id>/`). `--append-system-prompt` is
**omitted from argv entirely** when the agent has no `job` (R11) — never
passed an empty string — since `job` is optional on a daemon-created
agent, unlike a roster entry's (which was required).

**CNDLX-33 defect 3:** an empty or whitespace-only `job` is *present*, not
absent, and `spawnDaemonAgent` itself only ever checked `!== undefined` —
so before this fix it reached spawn as `--append-system-prompt ""`,
violating R3 (job absent means the flag is omitted, not passed empty).
Fixed at `createAgent` (`agent-actions.ts`), the core layer both the API
and any direct caller go through — not in the HTTP handler alone: an
empty or whitespace-only `job` is now refused as a typed `invalid-job`
before an id is even minted. **Chose refuse over silently normalizing to
absent** (the epic's own stated preference): an operator who typed an
empty job probably meant something, and saying so beats silently
dropping it. A record with `job: ""` can therefore no longer be created
through this path; see "Known gaps" for the one path this does not cover
(a hand-edited or pre-this-fix store entry).

### Why `claude --bg`

Verified live rather than assumed from `--help` text: `claude --bg` needs
no controlling terminal at all, sidesteps the workspace-trust dialog
(Claude Code's own docs: skipped whenever stdout is not a TTY, which a
background session's stdout structurally never is), and gives candlestix
`claude agents --json` / `attach <id>` / `logs <id>` / `stop <id>` /
`rm <id>` for free — Claude Code's own maintained surface, not
candlestix's own pty/log-capture code.

### The cgroup hazard, and where it actually lives

The first-ever `claude --bg` invocation for a Unix user spawns a
singleton process (`claude daemon run`) that every subsequent `--bg`
session on the host shares, inheriting whatever cgroup its first invoker
happened to be running in — verified by inspecting its `/proc/<pid>/cgroup`
live. Had candlestix's own systemd service happened to be that first
invoker, a later `systemctl --user restart candlestix` would SIGTERM that
cgroup and take the shared singleton down with it — and by extension
**every** background Claude Code session on the host, not just
candlestix's own.

`systemd-run --user --scope` around every launch avoids this: it moves the
invocation (and, if it is the first ever, the singleton daemon it gives
birth to) into its own independent, sibling cgroup under `app.slice`
*before* candlestix's own service cgroup ever contains it. **Verified live
again during this story's own T8 demonstration** (see "Demonstrations"
below): every spawned session's `/proc/<pid>/cgroup` read
`.../app.slice/candlestix-launch-<id>-<random>.scope`, never
`.../app.slice/candlestix-cndlx25-verify.service` (the scratch unit used
for that demonstration).

**Argv is never built as a shell string.** Every invocation goes through
`src/exec.ts`'s `runCommand`, which calls `Bun.spawn` with an argv array —
the job description, the mcp config path, everything, each its own array
element, handed to `execve` directly. No `/bin/sh -c` ever sees
operator-supplied text.

### MCP config and `--strict-mcp-config`

A daemon-created agent's MCP config is written to
`$XDG_RUNTIME_DIR/candlestix/agents/<id>/mcp.json` — **id-keyed** (R16),
never keyed by the agent's mutable name (that call site,
`legacyRosterMcpConfigPath`, was confined to the now-deleted roster spawn
path and is deleted with it). `--strict-mcp-config` is passed so the
agent's MCP servers are *exactly* what candlestix configured — today, an
empty set (`{"mcpServers":{}}`, S6): no stray project-level or user-level
MCP config leaks in. How an operator adds an MCP server to a daemon-created
agent is unowned by any current story — this is intentional for now (the
product's model is that setup happens in conversation) and is flagged
rather than buried.

## Restart survival

**Agents OUTLIVE the daemon and are RE-ADOPTED across a `systemctl --user
restart`, never killed and respawned — and, as of CNDLX-19, an agent
turned `off` stays off across that same restart, never helpfully
resurrected.** The reasoning: candlestix deliberately knows nothing about
roles, so the conversation an operator has had with an agent *is* that
agent's accumulated value. Tearing an agent down on every daemon restart,
or reviving one the operator deliberately silenced, would each destroy
exactly what candlestix exists to preserve.

Structurally, not by luck: every agent is a `claude --bg` background
session, a process tree that is a child of Claude Code's own persistent
background-session daemon — not of candlestix — and living in its own
`systemd-run --scope`, not candlestix's service cgroup (see "Spawning
agents"). `src/index.ts`'s shutdown handler reflects this directly: on
`SIGINT`/`SIGTERM` it stops its own reconcile-loop timer, its own alarm,
and its own health-signal timer, and does **nothing at all** to any
spawned agent. Their defined fate on shutdown, restart, or a candlestix
crash is: left running, completely untouched, exactly where they are —
which is what makes the next startup's re-adoption (or, for an `off`
agent, the next startup's continued *non*-adoption) possible at all.

### The reboot claim, stated at exactly its real strength (R13)

**This host carries a live, shared fleet of other epics' in-progress
work. Rebooting it to satisfy a checkbox would destroy real work to prove
a standard mechanism, and was correctly declined**, following the same
call CNDLX-1, CNDLX-17, and CNDLX-18 each made before this story. So the
reboot property is proven **structurally, not by observing an actual
reboot**:

- The durable agent set lives under `$XDG_STATE_HOME`, not
  `$XDG_RUNTIME_DIR` — a unit test (`test/unit/xdg.test.ts`,
  `"agentSetPath does not move when only the runtime dir changes"`,
  inherited from CNDLX-17) asserts the store's path is structurally
  independent of the runtime dir, which is the thing a reboot actually
  clears.
- A **simulated reboot** — a fresh daemon process with `$XDG_RUNTIME_DIR`
  wiped (registry and health signal both gone) but `$XDG_STATE_HOME`
  untouched — reloads the exact same agent set with the exact same on/off
  intentions, and re-adopts (never re-spawns) every still-live session
  purely from directory-match adoption, since the registry that would
  normally short-circuit that match no longer exists. **This was actually
  done, live, under a real systemd restart — see "Demonstrations" below —
  not merely reasoned about.**

**The claim this story is entitled to make, precisely**: *the mechanism is
verified to be correctly wired and demonstrated under a runtime-dir wipe.*
That is deliberately **not** the same claim as *a host reboot was
observed*. CNDLX-1's doc records that declaring this limit at exactly this
strength is what made its own equivalent claim approvable, and a vaguer
sentence would have been grounds to reject; that standard is inherited
here unchanged.

## Demonstrations

Run 2026-09-10, against a **scratch** systemd user unit
(`candlestix-cndlx25-verify.service`) and a **stubbed** `claude`
(`/tmp/cndlx25-verify/bin/claude` — a bash+python3 script that fakes
`--bg`/`agents --json`/`stop`/`rm` by forking a real, independently
`kill(pid,0)`-verifiable detached process per "session" and tracking it in
a JSON state file), never the real `claude` and never touching any real
agent set, registry, or session. `$XDG_CONFIG_HOME`, `$XDG_STATE_HOME`,
and `$XDG_RUNTIME_DIR` all pointed at a dedicated `/tmp/cndlx25-verify`
tree, entirely separate from this daemon's own (unit `butchr.service`,
unrelated). **Real sessions were not used**: they cannot be made to die on
cue, and risk other epics' live work on this shared host; a stub session
here IS a real, independently-verifiable OS process, just not a real
`claude` invocation. This is stated plainly rather than left implicit —
see "Standards you will be reviewed against" in this story's own ticket.

Three agents were seeded directly into a scratch `agents.json`:
`sleepy` (`off`), `steady` (`on`), `fragile` (`on`) — none pre-spawned.

**Off stays off, on stays alive, and one that dies is brought back — all
in the same run:**

1. Daemon started. First cycle: `steady` and `fragile` each get a real
   spawn (`INFO "steady" (...): spawn launched...`), each landing in its
   own `candlestix-launch-<id>-<random>.scope`, confirmed via
   `/proc/<pid>/cgroup` — distinct from the daemon's own
   `candlestix-cndlx25-verify.service` cgroup. `sleepy` gets **no** spawn
   attempt at all; its directory has no session, ever.
2. Next cycle: both sessions independently verify alive; the registry
   records real entries for both, keyed by agent id.
3. `fragile`'s backing pid was killed with `SIGKILL` directly (simulating
   a crash). The next cycle: `INFO "fragile" (...): spawn launched...` — a
   **genuinely new** session, new pid, new registry `spawnedAt`.
   `steady`'s pid was never touched.
4. `systemctl --user restart candlestix-cndlx25-verify.service` — a real
   restart, new Main PID. Immediately after: both `steady`'s original pid
   and `fragile`'s just-replaced pid were **still alive**, untouched by
   the restart. One reconcile cycle later: both re-adopted (no third
   `spawn` log line for either), and `sleepy` remained `off` in
   `agents.json`, with zero sessions ever recorded for it.

**Off/archived with a stray session — reported, never touched:** a
session was spawned directly (out of band, simulating an operator-created
stray) under `sleepy`'s own directory. The next cycle logged exactly one
`WARN "sleepy" (...): agent is "off" but 1 live session(s) are running
under its directory (...) — the loop never stops a session on its own,
only reports the disagreement`. The session was confirmed still running,
untouched, after that cycle. The **following** cycle, with the condition
unchanged, produced **no** repeated warning — T2's no-repeat rule, live.

**The legacy roster warning — once per start, never per cycle:** a
`roster.yaml` was placed at the scratch config path and the daemon
restarted. The very next log line was `WARN legacy roster file found at
"/tmp/cndlx25-verify/config/candlestix/roster.yaml" — it is NO LONGER
READ. ...`. The agent set was unaffected (still exactly the 3 seeded
agents, none named after the roster entry). One full cycle later, with
the file still present and unchanged, the warning did **not** repeat.

**The simulated reboot (R13):** with the daemon stopped, `$XDG_RUNTIME_DIR`
was wiped entirely (registry and health signal both deleted) while
`$XDG_STATE_HOME` was left untouched, then the daemon was started fresh.
Both `steady`'s and `fragile`'s sessions (their real pids from step 3
above) were confirmed alive immediately, and one cycle later the registry
was rebuilt from scratch with the same two sessions, adopted by directory
match (no registry to short-circuit through) — **no duplicate was ever
spawned**, and `sleepy` was still `off`.

**H2, observed again, live, in this story's own cleanup — not a
production concern.** After stopping the scratch unit and killing both
sessions' backing pids, their `candlestix-launch-*.scope` units remained
`active (running)` for a few seconds before systemd garbage-collected
them once their cgroups emptied — the same shape CNDLX-18 recorded for
`claude bg-pty-host --bg-spare`. This loop never stops a session (see
"The loop is SPAWN-ONLY" above), so it never needs "zero leftover
candlestix processes" as a postcondition and this observation does not
affect it — it matters only to verification cleanup, which is exactly
where it showed up here, and cleanup simply waited for it rather than
asserting cleanliness on the first check.

**Host confirmed back at baseline** after every demonstration: the
scratch unit file removed, `systemctl --user daemon-reload`'d, zero
`candlestix-cndlx25-verify`/`candlestix-launch-*` units left in
`systemctl --user list-units --all`, zero stray processes (`ps aux`
checked), and the entire `/tmp/cndlx25-verify` tree removed. Confirmed by
command, not assumed.

**Suite/typecheck/build**, run on a fresh `bun install --frozen-lockfile`
against this branch: **bun 1.3.14**, `bun run check` → **289 pass, 0
fail**, typecheck clean, build clean. `package.json` still has no
`dependencies` key.

## Demonstrations — CNDLX-32 (the daemon API over a Unix socket)

Run 2026-09-11, driving the daemon **as a real foreground `bun run
src/index.ts` process** with `$XDG_CONFIG_HOME`/`$XDG_STATE_HOME`/
`$XDG_RUNTIME_DIR` all pointed at a dedicated scratch tree, entirely
separate from this daemon's own state — never the real candlestix state,
never a real systemd unit installed/started/stopped. **`claude` and
`systemd-run` were both stubbed**, said plainly: two small Python scripts
on `PATH` ahead of the real binaries, backing `claude agents --json
[--cwd]` / `stop` / `rm` and `systemd-run ... -- claude --bg ...` with a
shared JSON "sessions" file, so the daemon's real parsing/matching code
(`agents-cli.ts`, `agent-session.ts`) runs against something real rather
than being mocked out. Every check below states the failure condition
before running it.

**1. Socket mode, before anything else.** `stat` on the bound socket and
its directory: `600 .../candlestix/api.sock` and `700
.../candlestix` — exactly section 1's requirement, not merely "the chmod
call didn't throw."

**2. The full lifecycle, over `curl --unix-socket`, one agent:**

```
GET  /v1/agents                              → {"ok":true,"agents":[]}
POST /v1/agents {"name":"demo-worker"}       → {"ok":true,"agent":{"id":"@01m27hmep77xg54nw8","name":"demo-worker","state":"on",...}}
# independent stat: .../agents/@01m27hmep77xg54nw8 exists; .../agents/@notreal00000000000 does not (control)
POST .../rename {"name":"demo-worker-renamed"} → {"ok":true,"agent":{...,"name":"demo-worker-renamed",...}}
# independent stat: the SAME id-keyed directory path still exists — rename never moved it
POST .../off                                  → {"ok":true,"outcome":{"kind":"turned-off"}}
# control: claude agents --cwd <dir> went from 1 entry to 0 after this call
POST .../off  (again)                         → {"ok":true,"outcome":{"kind":"no-change"}}   # not an error
POST .../archive                              → {"ok":true,"outcome":{"kind":"archived"}}
GET  .../attach-target                        → 409 {"ok":false,"error":{"kind":"archived","message":"agent is archived; ..."}}
POST .../unarchive                            → {"ok":true,"outcome":{"kind":"unarchived"}}   # lands on off, GET /v1/agents confirmed state:"off"
POST .../on                                   → {"ok":true,"outcome":{"kind":"turned-on"}}     # spawns via the stubbed systemd-run
GET  .../attach-target                        → 200 {"ok":true,"target":{"agentId":"...","agentName":"demo-worker-renamed","sessionShortId":"sess-jqchmm","sessionId":"sess-jqchmm-bdp8my7y"}}
POST .../open-terminal                        → 501 {"ok":false,"error":{"kind":"not-implemented","epic":"CNDLX-3","message":"opening a terminal window is not built yet — CNDLX-3 implements it. ..."}}
POST .../delete                               → {"ok":true,"outcome":{"kind":"deleted"}}
# independent stat: the directory is gone; GET /v1/agents is back to {"ok":true,"agents":[]}
```

Every status code above matched `statusForErrorKind`'s table exactly
(archived → 409, not-implemented → 501) — checked by `curl -w
'HTTP_STATUS:%{http_code}'` alongside each body, not inferred from the
body alone.

**3. Error shapes — never an HTML page, never a bare framework 404:**

```
GET  /v1/nope                → 404 {"ok":false,"error":{"kind":"unknown-route","method":"GET","path":"/v1/nope","message":"no route matches GET /v1/nope"}}
POST /v1/agents  { bad json  → 400 {"ok":false,"error":{"kind":"malformed-json","message":"request body is not valid JSON: JSON Parse error: Expected '}'"}}}
POST .../@notreal.../on      → 404 {"ok":false,"error":{"kind":"not-found","query":"@notreal00000000000","message":"no agent found named \"@notreal00000000000\""}}
```

**CNDLX-33 re-ran this section against two defects the epic found this shape did NOT yet cover — see "Demonstrations — CNDLX-33" below for the full re-run:** a malformed percent-escape in `{idOrName}` (previously a bare HTML 500 from an unguarded `decodeURIComponent`) and any other unexpected throw on the request path (previously the same HTML page, from `Bun.serve` having no `error` handler at all). Both are now this same typed JSON shape — `malformed-path` (400) and `internal-error` (500) — never an HTML page, on every route.

**4. Single-writer serialization, for real, not just the unit test's
generic critical section:** 15 concurrent `POST /v1/agents` fired as
background shell jobs against the SAME live socket, `wait`ed, then `GET
/v1/agents` — **15 agents, 15 unique names, nothing lost.** (The
generic negative control — the same shape of race demonstrably losing an
update WITHOUT the queue — lives in `test/unit/mutation-queue.test.ts`
and is re-run against this exact HTTP dispatch path with a no-op queue in
`test/unit/api/server.test.ts`; repeating that specific negative case
against a live foreground daemon would require deliberately shipping an
unserialized build, which was not done here.)

**5. Clean shutdown removes the socket.** `SIGTERM` → log line `received
SIGTERM, shutting down` then `supervisor loop, health timers, and the api
server are stopped` → `stat` on the socket path fails with ENOENT
immediately after. Process confirmed gone via `ps -p`.

**6. Refuses to steal a LIVE socket, loudly, naming the path — real
process, not a unit test.** With daemon A still running, a second daemon
process (B) started against the identical socket path: **exit code 1**,
log line `ERROR refusing to start: another candlestix daemon for this
user is already listening on ".../api.sock" — never stealing a live
socket`. Negative control confirmed in the same run: daemon A, unaffected
by B's refused attempt, still answered `GET /v1/agents` correctly
immediately after.

**7. Reclaims a STALE socket — the negative control for #6, with a real
crash, not a clean stop.** Daemon A's process was `SIGKILL`ed directly
(no chance to run its own shutdown/unlink code) — the socket file
survived the kill exactly as a real crash would leave it (`stat` still
showed `mode 600`), and a `curl` against it failed with `curl: (7)
Couldn't connect` (nothing listening any more). A third daemon (C)
started against that same path: **bound successfully**, and `GET
/v1/agents` immediately returned the full 15-agent list from before the
crash — genuinely reclaimed and serving, not the dead listener.

**A stubbed `claude`, stated plainly, and what it does NOT prove:** the
"session" pids in this demonstration are short-lived Python processes
that had already exited by the time the reconcile loop's own
`isPidAlive` check ran on them — visible in the daemon's own log as
repeated, honest `WARN ...: session "..." reported pid ..., which did not
independently verify as alive; not recording a heartbeat this cycle`
lines. This is the reconcile loop behaving exactly as designed (never
fabricating health) and is **not** evidence about attach-target, which
does not consult pid liveness at all — only that a live `claude agents
--json` entry exists under the agent's directory, which the stub does
provide honestly. The real-session case (a genuine `claude --bg` process
staying alive) is CNDLX-28's to demonstrate, not this task's.

**Host confirmed back at baseline** after this demonstration: all three
demo daemon processes stopped (`ps aux` checked — the two other
`bun run src/index.ts` processes visible on this shared host predate this
session and were never touched), the entire scratch demo tree removed,
zero references to real `$XDG_STATE_HOME/candlestix` or
`$XDG_RUNTIME_DIR/candlestix` anywhere in this demonstration.

**Suite/typecheck/build on this branch:** **bun 1.3.14** (this host's
shared `bun`) → `bun run check` → **337 pass, 0 fail**, typecheck clean,
build clean. Separately, against a **genuine bun 1.3.11** installed into
a scratch directory inside this task's own workspace by bun's own
installer (leaving the shared `bun` untouched):

```
$ <scratch>/bin/bun --version
1.3.11
$ <scratch>/bin/bun test
 337 pass
 0 fail
Ran 337 tests across 28 files.
$ <scratch>/bin/bun run build
Bundled 30 modules in 7ms
  index.js  64.11 KB  (entry point)
```

`package.json` still has no `dependencies` key.

## Demonstrations — CNDLX-33 (fix epic review findings)

Run 2026-09-11, driving `startApiServer` (`src/api/server.ts`) directly over
a **real Unix socket**, scratch XDG-shaped temp dirs, a stubbed
`runCommand` that throws loudly rather than silently succeeding if ever
actually invoked (never touched, said plainly, in either check below). Every
check states the failure condition before running it. This is the same
"error shapes" section CNDLX-32 demonstrated (see above), re-run with the
two new cases this task adds.

**1. The malformed percent-escape (defect 1a).** Failure condition: an HTML
body, a non-400 status, or any `kind` other than `malformed-path`.

```
GET  /v1/agents/%E0%A4%A/attach-target
  -> 400 application/json
  {"ok":false,"error":{"kind":"malformed-path","message":"the path segment \"%E0%A4%A\" is not a valid percent-encoded value: URI error"}}
POST /v1/agents/%E0%A4%A/on
  -> 400 application/json
  {"ok":false,"error":{"kind":"malformed-path","message":"the path segment \"%E0%A4%A\" is not a valid percent-encoded value: URI error"}}
```

**Control**, same run, immediately after: a validly-escaped but unknown
`idOrName` on the identical route still gets its normal typed 404, proving
the 400 above is specific to the decode failure, not a change to
not-found's own behaviour:

```
GET  /v1/agents/%40nope/attach-target
  -> 404 application/json
  {"ok":false,"error":{"kind":"not-found","query":"@nope","message":"no agent found named \"@nope\""}}
```

**2. The catch-all (defect 1b).** An injected fault — `mcpConfigPath`
throwing synchronously, a dependency nothing in `agent-actions.ts` wraps in
its own try/catch — reaching `createAgent` via a real `POST /v1/agents`.
Failure condition: the response contains the injected string
(`"injected-fault: ..."`), any stack-trace-shaped text, a status other than
500, or nothing appearing in the daemon's own log.

```
[server stderr] [2026-09-11T07:12:17.221Z] ERROR unhandled error handling POST http://localhost/v1/agents: Error: injected-fault: mcpConfigPath threw instead of returning a path
    at mcpConfigPath (.../live-demo-defects.ts:28:17)
    at createAgent (src/agent-actions.ts:268:90)

POST /v1/agents {"name":"demo"}
  -> 500 application/json
  {"ok":false,"error":{"kind":"internal-error","message":"an unexpected internal error occurred; see the daemon's own log for detail"}}
```

The full detail (message + stack) reached the log; **none of it — not the
injected string, not a stack frame — reached the response body.**

**Control**, same run, same socket, immediately after: `GET /v1/agents` (a
route that never calls `mcpConfigPath`) still answers normally:

```
GET  /v1/agents -> 200 application/json {"ok":true,"agents":[]}
```

**3. Defect 2 (strict create/rename body shape) and defect 3 (R3's
empty-job rule)** are demonstrated exhaustively as unit tests
(`test/unit/api/server.test.ts`'s two new `describe` blocks, and
`test/unit/agent-actions.test.ts`'s "R11" block) rather than repeated here
live — every row of the epic's own repro table, each with a control, plus
the "a rejected body spawns nothing" assertion on recorded commands the
epic explicitly required (not inferred from the status code). Chose to
show 1a/1b live here specifically because they are the two cases that
previously escaped the JSON error shape entirely (an HTML page) — the
thing this section exists to prove is fixed.

**Suite/typecheck/build on this branch:** `bun run check` → **357 pass, 0
fail** (337 inherited + 20 new), typecheck clean, build clean. The two
exhaustiveness mechanisms were verified live, not just asserted, the same
way CNDLX-27/32 verified theirs: `ERROR_STATUS` (`src/api/contract.ts`)
with `"malformed-path": 400` temporarily deleted failed `bun run
typecheck` with `TS2741: Property '"malformed-path"' is missing in type
...`, naming exactly that kind; restoring it passed. `ALL_WIRE_ERROR_KINDS`
(`src/error-wire-format.ts`) with `"invalid-job"` temporarily deleted
failed the same way (`TS2345`); restored, passed.

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
— the canonical clone location this project's own process document
describes (`~/code/<owner>/<repo>`) — and its `PATH` is set explicitly
(`%h/.bun/bin:%h/.local/bin:/usr/local/bin:/usr/bin:/bin`) because a
systemd user unit's `PATH` is **not** your login shell's, and `bun` in
particular was found off the default `PATH` on the investigated host.

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

This is one of the two most likely places in this whole product for a
fake capability, and `systemctl --user is-enabled` is evidence about
*enablement*, not about *boot*. Said plainly:

- **Verified**: the unit installs, `daemon-reload`s cleanly, `enable`s
  (`systemctl --user is-enabled` reports `enabled`), and `start`s under
  real systemd supervision — not just `bun run` — with the expected
  `Main PID`, journal output flowing through `journalctl --user`, and
  (critically for restart survival) a spawned agent living in its own
  sibling cgroup, never the unit's own — re-confirmed live in this
  story's own T8 demonstration (see "Demonstrations" above).
  `loginctl enable-linger` was already `yes` on the host this was
  verified against.
- **Not verified**: an actual host reboot. This host runs a live, shared
  fleet of many other agents' in-progress work; rebooting it was out of
  proportion to what this story needs and was not attempted — the same
  call CNDLX-1 made and this story inherits, stated at the same precise
  strength (see "The reboot claim" above).

### `journalctl` — the sharp edge that looks like an empty log, not an error

For a systemd **user** unit, the **system-level** `journalctl -u <unit>`
(no `--user`) prints `-- No entries --` — not a permission error, not any
other signal that the command was wrong. It looks exactly like an empty
log. The correct invocation for candlestix's own unit:

```sh
journalctl --user -u candlestix.service
journalctl --user -u candlestix.service -f   # follow
```

(Do not confuse this with `butchr.service` or `herdr.service` — a host may
run both, as user units, and they are different processes from
candlestix entirely.)

## XDG paths (`src/xdg.ts`, `src/paths.ts`)

| What | Path | Survives |
|---|---|---|
| Legacy roster file (retired — CNDLX-19/R12, no longer read by anything) | `$XDG_CONFIG_HOME/candlestix/roster.yaml`, falling back to `~/.config/candlestix/roster.yaml` | n/a — checked once at startup only, to name it in a warning |
| Registry (id-keyed, CNDLX-19 T4) | `$XDG_RUNTIME_DIR/candlestix/registry.json` | daemon restart, not reboot |
| Health signal | `$XDG_RUNTIME_DIR/candlestix/health.json` | daemon restart, not reboot |
| Per-agent MCP config (`agentMcpConfigPath`, R16, id-keyed) | `$XDG_RUNTIME_DIR/candlestix/agents/<id>/mcp.json` | daemon restart, not reboot |
| **Daemon API socket (`apiSocketPath`, CNDLX-32)** | `$XDG_RUNTIME_DIR/candlestix/api.sock` | daemon restart, not reboot — removed on clean shutdown, reclaimed if stale on startup |
| Durable agent set | `$XDG_STATE_HOME/candlestix/agents.json`, falling back to `~/.local/state/candlestix/agents.json` | **reboot** |
| Per-agent directory (CNDLX-23, S1) | `$XDG_STATE_HOME/candlestix/agents/<id>/`, same fallback base | **reboot** |

`XDG_CONFIG_HOME`/`XDG_STATE_HOME`/`XDG_RUNTIME_DIR` set to the **empty
string** are treated identically to unset (`src/xdg.ts`, unit-tested) — a
real case on some systems, not a hypothetical. When `XDG_RUNTIME_DIR` is
unset or empty, candlestix falls back to a uid-scoped subdirectory of the
OS tmpdir (`src/paths.ts`); this has weaker durability guarantees than a
real `XDG_RUNTIME_DIR` and is documented here as a fallback, not presented
as equivalent.

## The durable agent set (`src/agent.ts`, `src/agent-id.ts`, `src/agent-set.ts`, `src/agent-set-store.ts`, `src/agent-resolver.ts`)

Delivered by CNDLX-17: the record, id minting, the durable store (with its
invariants), and the id/name resolver.

- **`agent.ts`** — the `AgentRecord` type (`id`, optional `name`, optional
  `job`, a flat `state: "on" | "off" | "archived"`, `createdAt`) and
  `validateAgentNameSyntax`, a pure, standalone name-syntax check.
  "Deleted" is represented by absence from the store, not as a fourth
  state value — see `agent-set.ts` below.

- **`agent-id.ts`** — `mintAgentId({ now, random })`, pure, with clock and
  randomness as injected parameters. A minted id is `@` followed by 18
  Crockford-base32 characters (10 encoding the mint timestamp, 8 random).
  `isAgentId(value)` is the structural (store-free) shape check the
  resolver, the store, and `src/reconcile.ts`/`src/agent-directory.ts` all
  use.

- **`agent-set.ts`** — the pure half of the store: `AgentSet` (`{ version:
  1, agents: Record<id, AgentRecord>, retiredIds: string[] }`),
  `parseAgentSet`/`serializeAgentSet`, and the invariant-enforcing mutators
  a lifecycle verb calls: `insertAgent`, `renameAgent`, `deleteAgent` (R4:
  moves the id into `retiredIds` rather than discarding it, so a re-mint
  can never collide even under unlucky randomness).

- **`agent-set-store.ts`** — the impure load/save half: atomic writes, and
  a loader with **three distinct, typed outcomes** — `missing` (no file
  yet; the empty set; **a success**, per CNDLX-19 T1), `malformed`
  (unreadable or failed to parse; a distinct typed failure that **must
  never be treated as "no agents"** — see "Supervisor loop" above for how
  the reconcile loop honours this by skipping the entire cycle rather than
  guessing), `loaded` (read and parsed).

- **`agent-resolver.ts`** — `resolveAgent(agentSet, query)`: an id-shaped
  query resolves by id and never falls through to a name scan; otherwise
  it scans by name, returning a typed `not-found` or the agent.

### Which XDG base, and why (R5)

The durable agent set lives under **`$XDG_STATE_HOME`**, deliberately not
under `$XDG_RUNTIME_DIR` alongside the registry, health signal, and
per-agent MCP config. Two files, two lifetimes, on purpose: the agent set
is the thing only candlestix knows and must survive a reboot; the
runtime-dir contents either are reconstructable from `claude`'s own live
state (the registry) or are meant to die with the session (the health
signal, the MCP config).

## The lifecycle action set (`src/agent-lifecycle.ts`, `src/agent-directory.ts`, `src/agent-session.ts`, `src/agent-spawn.ts`, `src/agent-actions.ts`)

Delivered by CNDLX-18, on top of everything in "The durable agent set"
above: the eight verbs — `create`, `on`, `off`, `rename`, `archive`,
`unarchive`, `delete`, `list` — as plain callable functions. **As of
CNDLX-19, the state these verbs write is exactly what the reconcile loop
reads** — see "Supervisor loop" above. **As of CNDLX-32, these are also
exactly the functions the daemon API calls** — see "The daemon API"
below. Still no CLI, no webapp (CNDLX-28/16's scope), and the CLI's
in-place `attach` is still not built (also CNDLX-28's) — though R18's
`attach-target` query and the `open-terminal` seam both are, see below.

- **`agent-lifecycle.ts`** — the PURE transition rules (R9): `decideOn`/
  `decideOff`/`decideArchive`/`decideUnarchive`/`decideDelete`, each a
  total function of the current `AgentLifecycleState`. `unarchive` always
  lands on `off`, never `on`. `delete` is legal unconditionally. Also
  here: `checkAgentNameAllowed` (R17), the reserved-word list
  (`create`, `attach`, `on`, `off`, `rename`, `name`, `archive`,
  `unarchive`, `delete`, `list` — the whole action-set vocabulary, not
  just the CLI verbs, since reserving a word later is a breaking change
  for any agent already holding it).

- **`agent-directory.ts`** — the per-agent directory
  (`$XDG_STATE_HOME/candlestix/agents/<id>/`) and guarded recursive
  removal. `guardAgentDirectoryRemoval` is **pure** and refuses unless the
  argument is structurally a minted id and the derived path is a direct
  child of the agents base directory.

- **`agent-session.ts`** — finds an agent's live `claude --bg` session(s)
  by its **directory** (never a name-keyed registry), stops/removes them
  with exactly `claude stop <id>` / `claude rm <id>` — never `systemctl`,
  never a cgroup. Stopping acts on **every** exact directory match, not
  just the first.

- **`agent-spawn.ts`** — `spawnDaemonAgent`, the daemon-created-agent spawn
  entry point (R11: `job` optional, `--append-system-prompt` omitted
  entirely when absent; S6: an empty, `--strict-mcp-config`-enforced MCP
  config).

- **`agent-actions.ts`** — the eight verbs themselves: load the store (a
  `malformed` result refuses every action outright), resolve
  `<id-or-name>`, consult the pure decision, apply the effect, **persist
  the store write only after every effect has succeeded** — and when the
  store write itself then fails, report a typed `store-write-failed`
  naming exactly which effect already happened, rather than leaving an
  unhandled rejection or a silently-stale record. `createAgent` also
  refuses an empty/whitespace-only `job` as a typed `invalid-job`
  (CNDLX-33 defect 3, R3) — before minting an id, so no directory or
  session is ever touched for a refused create.

## The daemon API (`src/api/`, `src/attach-target.ts`, `src/open-terminal.ts`, `src/mutation-queue.ts`)

Delivered by CNDLX-32 (CNDLX-27's task): the whole eight-verb action set,
plus `attach-target` and the `open-terminal` seam, reachable over
**HTTP/1.1 with JSON bodies, over a Unix domain socket.** No TCP listener.

### Why a Unix socket, and why HTTP over it

**Authentication is the filesystem: only the same Unix user can connect.**
This API can delete an operator's agents and their conversations; the only
client this epic ships (the CLI, CNDLX-28) runs on the same machine as the
same user. A TCP port would expose delete-everything to anything that can
reach it, and would need an auth design nothing here has a client for.

**HTTP keeps every route and body transport-independent** — the load-
bearing half of the choice. When CNDLX-16 needs a browser that is not on
the daemon's machine, it can add an authenticated listener, or a proxy
onto this socket, **additively, without changing a single route.** A
bespoke line protocol over the socket would have been simpler today and
would have made that later step a rewrite instead.

### Where the socket lives, and how its path is resolved

`xdg.ts`'s `apiSocketPath` (wrapped by `paths.ts`'s impure
`apiSocketPath()`) resolves to `$XDG_RUNTIME_DIR/candlestix/api.sock` —
the ONE function both the daemon (which binds it) and any client (the
CLI) call, so the two surfaces cannot disagree about where the socket is.
Same file both the registry and the health signal already live beside.

- **Socket file mode `0600`, its containing directory mode `0700`** —
  `startApiServer` (`src/api/server.ts`) `chmod`s both explicitly after
  creation, since `mkdir`'s own `mode` is subject to umask and is a no-op
  when the directory already existed. Asserted with `stat` in
  `test/unit/api/server.test.ts`, not assumed from the `chmod` call
  succeeding.
- **Startup never steals a live socket.** If the socket path already
  exists, the daemon probes it with a real `Bun.connect` before doing
  anything else: if something answers, this is another candlestix daemon
  for this user already running, and startup **refuses, loudly, naming
  the full path** — the whole daemon process exits nonzero, not just the
  API component, since a second daemon writing the same store is exactly
  the two-writer hazard "Single-writer serialization" below exists to
  prevent, now at the process level rather than the in-process level.
  Verified live (not merely reasoned about): `Bun.serve({unix: path})`
  itself does **not** refuse to bind over a path something is already
  listening on — it silently rebinds, which is the exact "steal" this
  probe exists to prevent by running strictly BEFORE any call to
  `Bun.serve`, never after.
- **A stale socket (file present, nothing listening — the ordinary
  shape of an unclean shutdown) is unlinked and re-bound.** The negative
  control that makes "refuses to steal" a real claim rather than "always
  refuses": `test/unit/api/server.test.ts` kills a real, separate `bun`
  process with `SIGKILL` (so it never gets a chance to clean up after
  itself — a `server.stop()` called in the same process, by contrast,
  unlinks its own socket file, which does NOT reproduce this case) and
  shows the daemon reclaims the leftover file rather than refusing.
- **Clean shutdown removes the socket file** — `src/index.ts`'s shutdown
  handler calls the returned handle's `stop()`, which stops accepting
  connections and unlinks the socket.

### The route table

`{idOrName}` is one URL-encoded path segment, resolved by CNDLX-17's ONE
id/name resolver (never a second one). Defined once, in
`src/api/contract.ts`, which the CLI (CNDLX-28) imports rather than
restating.

| Method | Path | Body | Does |
|---|---|---|---|
| GET | `/v1/agents` | — | list — every non-deleted agent, archived included (R10) |
| POST | `/v1/agents` | `{name?, job?}` | create (mint id, make directory, start). `job` exists **only** here (R3) |
| POST | `/v1/agents/{idOrName}/on` \| `off` \| `archive` \| `unarchive` \| `delete` | — | the matching action |
| POST | `/v1/agents/{idOrName}/rename` | `{name}` | rename; never moves the directory |
| GET | `/v1/agents/{idOrName}/attach-target` | — | the R18 attach query |
| POST | `/v1/agents/{idOrName}/open-terminal` | — | the window-opening seam for CNDLX-3 |

**Every body above is checked for shape, not just field types (CNDLX-33
defect 2).** A body is either absent (meaning `{}`) or a JSON object whose
keys are a subset of the ones listed — a bare string/number/array/`null`,
or an object with an unrecognized key (a typo'd field name), is a typed
`invalid-request-body` naming exactly what was wrong, **before** any
create/rename is attempted. Before this fix, `createAgent`'s handler did
`bodyResult.body ?? {}` and read `.name`/`.job` off whatever survived that
— a string, number, array, or `null` body all minted an agent and spawned
a session, and a misspelled key (`{"nmae":"typo"}`) silently produced an
unnamed agent rather than reporting the typo. **A rejected body now spawns
nothing**, verified on recorded commands, not inferred from the status
code (`test/unit/api/server.test.ts`).

### The response body IS the action's own result union

Serialized as-is: `{ok:true, ...}` or `{ok:false, error:{kind, message, ...}}`.
`src/api/contract.ts` re-exports the action set's own result types rather
than restating a parallel set that could drift from what the server
actually executes. **HTTP status is a coarse hint, not the contract** — a
client reading only the body must be fully correct without ever consulting
it:

| status | when |
|---|---|
| 200 | every `ok:true` |
| 400 | `invalid-name`, `invalid-request-body`, `malformed-json`, `malformed-path`, `invalid-job` |
| 404 | `not-found` (unknown id-or-name), `unknown-route` |
| 409 | `ambiguous`, `name-taken`, `already-archived`, `archived`, `not-archived`, `off`, `no-live-session`, `multiple-live-sessions` — every state-conflict refusal |
| 501 | `not-implemented` (open-terminal, honestly) |
| 500 | `store-malformed`, `store-write-failed`, `session-lookup-failed`, `session-cleanup-failed`, `directory-create-failed`, `spawn-failed`, `directory-removal-failed`, `internal-error` — daemon-side trouble, never the client's fault |

**`malformed-path` (CNDLX-33 defect 1a) and `internal-error` (CNDLX-33
defect 1b)** are new in this task: a malformed percent-escape in
`{idOrName}` and a catch-all around every unexpected throw on the request
path, respectively — both previously reached the client as `Bun.serve`'s
own default HTML error page, never this table. `internal-error` **logs
the real detail server-side (`src/log.ts`) and never returns it, or a
stack trace, to the client** — see "Demonstrations — CNDLX-33" below.
`invalid-job` (CNDLX-33 defect 3) is `createAgent`'s own refusal of an
empty/whitespace-only `job`, part of `CreateAgentError` rather than this
API layer's own `ApiServerError` — same table, same enforcement.

The exact mapping is `src/api/contract.ts`'s `statusForErrorKind`, a pure
function kept exhaustive over the same two kind-unions
`error-wire-format.ts` enumerates (see below) — a kind missing from either
fails `bun run typecheck`.

An **unknown route**, a **malformed JSON body**, a **malformed
percent-escape in `{idOrName}`**, or **any other unexpected throw
anywhere on the request path** gets this same JSON error shape, never an
HTML page, an empty body, or a bare framework 404 or 500 — see
`test/unit/api/server.test.ts`. The last of these is enforced by a
catch-all wrapping every request (`handleRequest` in `src/api/server.ts`,
plus `Bun.serve`'s own `error` option as defense-in-depth): **this claim
used to be false** — before CNDLX-33, `Bun.serve` was constructed with no
`error` handler at all and the route matcher's `decodeURIComponent` was
unguarded, so both cases reached the client as Bun's default HTML page.

### Every refusal carries a server-produced `message` (R8's gap, closed)

At CNDLX-27's read of `f261c9b`, nine variants that reach the wire carried
`error`/`query`/`reason`/`failed` fields but no `message`: the resolver's
`not-found` and `ambiguous`, `store-malformed`, `store-write-failed`,
`session-lookup-failed`, `session-cleanup-failed`,
`directory-create-failed`, `spawn-failed`, `directory-removal-failed`. All
nine now carry a server-produced `message` alongside their existing
structured fields — nothing a client might want was dropped.

**The fix is in core** (`agent-resolver.ts`, `agent-actions.ts`), not in
this API layer — a surface patching in wording after the fact is exactly
the second vocabulary R8 forbids, and there would end up being three of
them once the CLI and webapp each did their own. This API layer, the CLI,
and the webapp all show the same core-produced string verbatim.

**The evidence is `src/error-wire-format.ts`, not spot checks.** It
enumerates every error kind reachable at the wire (a strict superset of
the original nine — attach-target's and open-terminal's own new refusals
are held to the identical standard from the start) via **two independent,
exhaustive mechanisms**, both of which fail `bun run typecheck` the moment
a new error variant is added anywhere in the action set without being
accounted for here:

1. `ALL_WIRE_ERROR_KINDS`, an array checked against
   `AnyActionError["kind"]` by a `checkExhaustive` helper — a missing kind
   fails to typecheck, naming the missing kind in the compiler error.
2. `hasServerMessage`'s own `switch`, with a `default: assertNever(err)`
   branch that only compiles if every kind was handled.

`test/unit/error-wire-format.test.ts` then iterates
`ALL_WIRE_ERROR_KINDS` — never a hand-written list of its own — asserting
`hasServerMessage` is true for a minimal fixture of every kind, **with a
negative-control fixture (message missing, and separately message
empty) proving the check can actually fail, not just always pass.**

### `attach-target` — R18, one query, never an act (`src/attach-target.ts`)

Resolves `{idOrName}`, then refuses or returns the live session:

- **`off`** → refused; message says it is off and `on` is the way. Never silently started.
- **`archived`** → refused, same reasoning.
- **Unknown id-or-name** → the typed `not-found`.
- **`on` + exactly one live session** → `{ok:true}` with the agent's id,
  its name if any, the session's **short id** (what `claude attach <id>`
  takes — `agents-cli.ts`'s `BackgroundAgentInfo.id`) and the full session
  id (`.sessionId`).
- **`on` + zero live sessions** → a typed refusal saying so and that it is
  being brought back. Not a hang, not a spawn.
- **`on` + more than one** → a typed refusal **listing every one** —
  never picks the first match (R15's mirror gap).

**The decision (`decideAttachTarget`) is pure and unit-tested per branch**,
zero and multiple sessions included, with no lookup to mock — R9's split,
applied here exactly as `agent-lifecycle.ts` applies it to the eight verbs.
The impure wrapper (`getAttachTarget`) loads the store, resolves, calls
`agent-session.ts`'s `findAgentSessions` (already "the lookup half of
attach" per CNDLX-14's own doc) under the agent's directory, then hands
both to the pure decision.

**Two attaches at once is correct, and candlestix does not arbitrate it.**
attach-target is a read-only query; handing the same target to two
simultaneous callers is not a conflict to resolve. The terminal is the
caller's concern (R18) — what two simultaneous `claude attach` clients
actually do is Claude Code's own behaviour. Unlike the mutating verbs
below, attach-target is **not** run through the mutation queue.

**Measured for real (CNDLX-31): two simultaneous `candlestix <agent>`
attaches, each through its own real pseudo-terminal, to the same live
`claude --bg` session — no harm observed.** Both terminals rendered the
same shared session view; a message typed in terminal A and a message
typed in terminal B were both processed in order, and both terminals'
own screens showed both exchanges (proof the two attaches are two windows
onto one shared session, not two independent forks of it). Detaching
terminal A (`Ctrl+Z`, exit `0`) left terminal B fully functional — a
further message typed in B afterward was answered normally. `claude
agents --json`, read independently after the whole measurement, showed
the same session id and pid throughout, `status: "idle"`, never a
crash or a second process. `claude logs <id>`, read independently, showed
every probe word from both terminals present exactly once each, in
order — no lost or corrupted turn. **Conclusion: candlestix's "do not
lock or arbitrate" ruling is safe as measured.** No lock was invented.
The falsifier that would have stopped this task and escalated to the
epic — a corrupted session, a lost conversation turn, or one client
silently killing the other — was not observed. See the PR description
for the full transcript.

### `open-terminal` — the honest seam for CNDLX-3 (`src/open-terminal.ts`)

Opening a terminal window on the operator's desktop is **webapp-only**
(the human's correction of 2026-09-10) and is CNDLX-3's to implement. This
task defines the endpoint so CNDLX-16 has something to call:

- Runs the **exact same** attach-target query first — not-found, off,
  archived, zero-session, and multi-session refusals are **byte-for-byte
  identical** to attach-target's own (shared code, never restated
  branches; `test/unit/open-terminal.test.ts` checks this directly).
- **Only when attach-target would have succeeded** does it return a typed
  `not-implemented` refusal, naming **CNDLX-3** honestly. Never a stub
  that pretends to work.
- Named `open-terminal`, deliberately not "attach", so no reader confuses
  this daemon-opens-a-window path with the CLI's in-place attach.
- **Reserved in `agent-lifecycle.ts`'s ONE `RESERVED_AGENT_NAMES` list**,
  in this same PR, per R17's standing rule ("whoever names a new verb
  reserves it at the same moment") — `test/unit/agent-actions.test.ts`
  checks both `create` and `rename` refuse it, each with a control
  showing an unreserved lookalike name still passes.

### Single-writer serialization (`src/mutation-queue.ts`)

Until this task, nothing ever called the action set concurrently — no
server existed. Once an API exists, two concurrent requests can each
`load → modify → save` the durable agent set, and the second save can
silently clobber the first's change. Every **mutating** route
(`create`/`on`/off`/`archive`/`unarchive`/`delete`/`rename`) now runs
through a plain FIFO promise-chain mutex inside the daemon process — no
lock object, no semaphore, nothing that can deadlock. `list`,
`attach-target`, and `open-terminal` are read-only and are **not** queued.

**What was checked about the reconcile loop, so the queue's scope is
exactly right:** `supervisor.ts` **loads** the agent set every cycle but
calls no `saveAgentSet` on that path — verified by reading the module, not
assumed. So the API server is the **only writer** in the process, and
serializing mutating API requests against each other is sufficient; there
is no second writer to also coordinate with.

**Proof, not just a mutex object existing** (`test/unit/mutation-queue.test.ts`
and `test/unit/api/server.test.ts`): a critical section shaped exactly
like `agent-actions.ts`'s own verbs (read the whole shared value, await —
simulating the real I/O window between load and save — then write back a
value computed from the now-stale copy) is fired concurrently twice, both
**without** the queue (the negative control: an update is lost) and
**with** it (both land). The same distinction is then run again on the
**real HTTP dispatch path** (`handleRequest`), passing a no-op
pass-through queue vs. the real one, then with 15 concurrent real
`POST /v1/agents` requests over a real temp-dir store, confirmed by a
fresh `loadAgentSet` read independent of the in-memory dispatch.

### `curl` example

```sh
# The daemon logs its resolved socket path at startup ("api server
# listening on unix socket ..."); with scratch XDG dirs it is
# $XDG_RUNTIME_DIR/candlestix/api.sock.
curl --unix-socket "$XDG_RUNTIME_DIR/candlestix/api.sock" http://localhost/v1/agents
# {"ok":true,"agents":[]}
```

See "Demonstrations" below for the full behavioural walkthrough (create,
list, rename, off/no-change, archive, attach-target, unarchive, delete)
driven entirely through `curl --unix-socket` against a foreground daemon
with scratch XDG dirs.

## The candlestix CLI (`src/cli/`)

CNDLX-30 built the human-facing surface; CNDLX-31 rebased it onto CNDLX-27's
real, merged daemon API and ran the real end-to-end demonstration below.
**`candlestix` is a thin client of the daemon API — it never touches the
store, the agent set, or any action/lifecycle module directly.** Every
state-changing thing it does goes out over HTTP, on a Unix domain socket,
to the daemon. A reviewer can check this by grep: nothing under `src/cli/`
imports `agent-actions.ts`, `agent-set.ts`, `agent-set-store.ts`,
`agent-resolver.ts`, `agent-session.ts`, `agent-spawn.ts`,
`agent-directory.ts` or `agent-id.ts` — the one exception, `src/agent.ts`'s
`AgentRecord` **type**, is imported type-only (via the contract module's own
re-export), for the wire shape, never as a runtime value.

### The real contract module (`src/api/contract.ts`) — the swap CNDLX-31 made

CNDLX-30 was built while CNDLX-27's daemon API did not yet exist, against a
**temporary, local restatement** of the contract it was promised
(`src/api-contract.ts`: a guessed socket-path resolver, the route table, and
the wire envelope/success types — none of it verified against a real server,
because none existed yet). **CNDLX-31 deleted that file outright** once
CNDLX-27 merged, and repointed every CLI import at `src/api/contract.ts` —
CNDLX-27's real, merged contract module, which itself re-exports the socket
resolver from `src/paths.ts` and the wire *response* types directly from the
action set's own result unions (`agent-actions.ts`, `attach-target.ts`,
`open-terminal.ts`), rather than restating them. Only the route table
(`API_ROUTES`) and the request-body types are genuinely new to the contract
module; the CLI's own `src/cli/api-client.ts` builds every path it calls from
`API_ROUTES`' templates rather than hand-writing path strings a second time.

**THE SOCKET-PATH DEFECT, found before it ever shipped.** The provisional
module built `<candlestix runtime dir>/candlestix.sock` — a filename it
guessed — while the real resolver, `apiSocketPath()` (`src/paths.ts`, bound
by the daemon in `src/index.ts`), builds `<candlestix runtime dir>/api.sock`.
Had this swap only corrected the filename in place, the CLI would have kept
its own second derivation of a path that must have exactly one — safe today,
silently divergent the next time either side's XDG-input handling changed.
**The fix imports `apiSocketPath` itself** (`src/cli/bin.ts`), so the CLI's
resolver *is* the daemon's, not a copy of it. Proven by
`test/unit/cli/socket-path.test.ts` with a reference-identity check
(`toBe`, not `toEqual`) — a negative control reconstructs the deleted
module's own derivation shape (same XDG inputs, the guessed
`candlestix.sock` filename) to show the identity check is capable of
failing, not vacuously true. The end-to-end demonstration below also shows
the running CLI reach the real daemon's actual bound socket, independently
of the unit test.

**Field-name reconciliation.** `AttachTargetSuccess`'s shape was CNDLX-30's
own flagged most-likely-wrong guess: the temporary module put `agentId`,
`name`, `sessionShortId` and `sessionId` flat on the success body. The real
`AttachTargetResult` (`src/attach-target.ts`) nests them under a `target`
field and names the agent's name field `agentName`, not `name`
(`{ ok: true, target: { agentId, agentName, sessionShortId, sessionId } }`).
Every other field name and shape CNDLX-30 guessed at — `agent`, `agents`,
`outcome.kind`, the R6 no-change shapes — matched what CNDLX-27 actually
shipped exactly; verified by reading the merged action-set result types
directly, not inferred from a passing test (a mismatch here renders
`undefined` silently and no fake-server test would catch it on its own).

### The grammar (`src/cli/grammar.ts`) — pure, and deliberately ignorant of names

```
candlestix                          create a blank agent
candlestix --name foo [--job "..."]  create, naming it (job: create-only, R3)
candlestix <id|name>                attach, in this terminal
candlestix <id|name> on|off         start/stop the session
candlestix <id|name> name <new>     rename (alias: "rename")
candlestix <id|name> archive        stop and hide (kept)
candlestix <id|name> unarchive      return to off
candlestix <id|name> delete [-y|--yes]   the one destructive verb; confirms
candlestix list [--archived]        the live set; archived hidden unless --archived
```

The parser knows exactly two top-level words of its own (`list`, `create`)
and seven second-position verbs (`on`, `off`, `archive`, `unarchive`,
`delete`, `name`/`rename`). **It carries no second copy of the action
set's ten-word reserved-name list, and validates no name syntax at all** —
both are `agent-lifecycle.ts`'s job, enforced once. `src/cli/grammar.ts`
has **zero imports** (checked by its own test), which is the strongest
available proof it cannot be consulting a second list. An id-or-name that
happens to collide with a verb word (e.g. literally `candlestix on`) is
simply passed through as an attach target; the daemon refuses it as
not-found, because the action set can never let such a name exist.

An unknown verb, a missing/extra argument, or a bare `--`/unrecognized
flag-like token where a name is expected are all usage errors (exit `2`),
never a guess.

### The API client (`src/cli/api-client.ts`) — HTTP/1.1 + JSON over a Unix socket

Uses `node:http`'s `socketPath` option (verified locally, against a
`Bun.serve({unix, fetch})` fake server, on the only bun available on this
host — **1.3.14, not the laptop's 1.3.11**; nothing here is known to need
anything newer, but it was not possible to verify at the floor itself — see
"Bun version" below). `{idOrName}` is URL-encoded as one path segment
(tested with a name containing both a space and a slash).

**Daemon-down, distinguished where cheap:** a connect failure is followed
by a `stat` of the socket path itself. `node:http`'s Unix-socket error path
was found, empirically, to collapse "no such file", "a file exists but
nothing is listening" and "a file exists but isn't a socket at all" into
the same generic connect error with no reliable `err.code` to switch on —
so this client does the cheap thing instead of trusting that code. This is
best-effort (the file's presence can change between the failed connect and
the `stat`), not a guarantee.

**Transport trouble is kept separate from an ordinary API refusal at every
layer:** `unreachable` (no connection at all), `protocol-error` (a response
came back that isn't the `{"ok": ...}` envelope the contract promises — not
valid JSON, or valid JSON missing `"ok"`), and `ok` (a real envelope,
`true` or `false`). Only a real `ok:false` is ever rendered as a refusal.

### Rendering, exit-code classification, and the message-less-refusal fallback (`src/cli/render.ts`)

**R8, applied here:** `error.message` is printed verbatim whenever present
— never the CLI's own wording for a refusal. **The one guard this layer
adds on top of that (a defensive guard, not expected to fire):** if a
refusal arrives with no `message` at all, the CLI prints exactly one
generic line naming the `kind` and saying the daemon sent no message,
rather than inventing per-kind wording of its own. This is unit-tested
(including a negative control: two different missing-message kinds render
two different lines, proving it is not a fixed string). **It is expected
NEVER to fire against CNDLX-27's real, merged server** — every error kind
reachable at the wire is verified, both at compile time and at runtime
(`src/error-wire-format.ts`, part of CNDLX-27's own suite), to carry a
server-produced message. The end-to-end demonstration below shows no route
reaches this fallback against the real daemon, with a stated falsifier. If
it is ever observed to fire against a real daemon, that is a CNDLX-27
defect to report, never something to quietly paper over here.

**Exit-code classification (CNDLX-31, the epic's settled ruling) —
`classifyRefusalExitCode`:** not every `ok:false` is the same kind of "no".
A refusal (`already-archived`, `off`, `not-found`, a declined delete, ...)
means the request was understood and declined — exit `1`. A **daemon-side
failure** (`store-malformed`, `spawn-failed`, `session-lookup-failed`, ...)
means the request was fine and the daemon itself broke — a script reading
`1` there would wrongly conclude the request was rejected and not retry, so
these exit `3` instead, the same code as daemon-unreachable. The `message`
is still printed verbatim either way; only the exit code changes.
Classified through the contract's own `statusForErrorKind(kind) >= 500`
rather than a hand-written list of daemon-side kinds in the CLI — the same
one-list discipline as R17, so a kind added to the daemon's union later
lands on the right exit code with no CLI change. **The implementation trap,
found reading the merged code and pinned by a test named after it:**
`ERROR_STATUS[kind]` is `undefined` for a kind outside the table, and in
JavaScript `undefined >= 500` is `false` — so the naive
`status >= 500 ? EXIT_DAEMON_UNREACHABLE : EXIT_REFUSAL` silently sends an
*unrecognised* kind (a newer daemon, an older CLI) to `EXIT_REFUSAL`, the
exact opposite of the ruling. `classifyRefusalExitCode` checks
`status === undefined` explicitly rather than relying on the comparison
alone.

R6's no-change diagonal renders distinctly from a real transition and from
a refusal (`already off` vs. `turned off` vs. the refusal's own message,
each asserted by its own test).

### attach — in this terminal, end to end, no daemon round trip for the terminal itself (`src/cli/attach.ts`, `src/cli/attach-runner.ts`)

1. `GET .../attach-target`. A refusal (off, archived, not-found, zero or
   several live sessions) is printed verbatim and exits non-zero —
   **never starts an off agent to attach to it** (R18).
2. On success, the terminal is handed to `claude attach <sessionShortId>`
   with stdin/stdout/stderr **inherited**, and the CLI process's own exit
   status becomes **exactly** the child's — this is tested with a
   deliberately chosen exit code (`3`) that collides with candlestix's own
   `EXIT_DAEMON_UNREACHABLE`, to prove no translation or clamping happens.
   Bun (like Node) has no `exec()`-style process-image replacement, so this
   is a spawn-with-inherited-stdio followed by exact propagation — the
   fallback the ticket itself sanctions when true in-place replacement
   isn't available.
3. **The non-TTY decision, made explicitly rather than left to hang:** if
   either stdin or stdout is not a TTY, the hand-off refuses outright
   (`EXIT_REFUSAL`) with a message saying both must be a TTY, and
   `spawnAttach` is never invoked. This check happens **after** a
   successful attach-target response, matching the ticket's own ordering
   (resolve first, then decide about the terminal) — a `--cwd`-piped or
   cron-triggered `candlestix <agent>` fails fast and clearly rather than
   hanging on a `claude attach` that can never get real input.
4. **Measured for real (CNDLX-31), against a real daemon and a real `claude --bg` session, through a real pseudo-terminal — see the PR description's end-to-end transcript for the falsifiers and independent checks:**
   - `claude attach --help` on this host prints exactly: *"Open the background session in this terminal. ← returns to agent view, Ctrl+Z drops back to your shell. The session keeps running either way."*
   - **Detach (Ctrl+Z) genuinely returns control to the shell while the session keeps running** — `candlestix <agent>` exits `0` (the child's own exit code, propagated exactly, per item 2 above), and an independent `claude agents --json` read immediately after shows the same session id and pid, `status: "idle"`.
   - **Two simultaneous attaches to the same session are safe**, per the epic's own ruling that attach-target does not lock or arbitrate — see "Two-terminal attach" in "The daemon API" below for the measurement and what was and was not observed.

### delete — confirms, never defaults to yes (`src/cli/confirm.ts`)

The confirmation matrix, every branch unit-tested plus exercised end to end
through `runCli` against a fake server:

| stdin | `--yes`/`-y` | Result |
|---|---|---|
| TTY | no, answers "yes"/"y" (case-insensitive, trimmed) | proceeds |
| TTY | no, answers anything else (including a bare Enter) | **declined**, exit `1`, daemon's `delete` route never called |
| TTY | yes | proceeds, **without ever prompting** |
| not a TTY | no | **refused outright**, exit `1`, message says to pass `--yes` — never prompts (a prompt here would hang forever) |
| not a TTY | yes | proceeds, without any prompt |

A bare Enter is deliberately **not** an affirmative. On a TTY without
`--yes`, the CLI best-effort fetches the live list to show **which agent**
(id and name, when it can find a match) in the prompt; if that lookup
fails or finds nothing, it falls back to echoing back exactly what the
operator typed. The confirmation itself is interaction that lives entirely
in the CLI — the daemon's `delete` route is the destructive action itself
and is asked to confirm nothing.

### Exit codes — and EXACTLY where candlestix's own codes stop applying

| Code | Meaning | Where it comes from |
|---|---|---|
| `0` | success (including an R6 no-change success, e.g. "already off") | candlestix |
| `1` | **"candlestix asked and was told no"** — an ordinary refusal, the daemon's `error.message` verbatim; a CLI-side policy refusal (attach's non-TTY check); or delete's confirmation being **declined at the confirmation prompt** (an explicit "no", not a daemon refusal — see "delete" above) | candlestix |
| `2` | a usage error (bad grammar) | candlestix |
| `3` | **"the daemon could not serve the request"** — unreachable, its response could not be understood, **or a daemon-side failure** (the store, a session lookup/cleanup, or a directory/spawn operation broke; the request itself was fine) | candlestix |

**Exit `1` is never a daemon-side failure, and exit `3` is never "the operator said no."** A daemon-side `ok:false` (e.g. `store-malformed`, `spawn-failed`) is classified to `3`, not `1`, precisely so a script can tell "retry later, this wasn't rejected" apart from "don't retry, this was declined." See "Rendering, exit-code classification..." above for the classification rule and the trap it was built to avoid.

**These four codes govern ONLY the pre-attach path — including every
attach-target refusal.** The instant `candlestix <id|name>` successfully
hands the terminal to `claude attach`, the process's exit status becomes
**`claude attach`'s own**, unmodified, for as long as that session runs —
and that status can be *any* value, including `0`, `1`, `2` or `3` from the
table above, by coincidence rather than by candlestix's choice. A script
that needs to tell "candlestix refused before ever attaching" apart from
"the attached session itself exited with N" has exactly one place to look:
whether the command that ran was a bare `candlestix <id|name>` (attach) —
if so, and it printed nothing on stderr from this table's own wording, the
exit code is `claude attach`'s; every other form's exit code is always
candlestix's own.

### When the daemon is not running

The CLI names the exact socket path it tried, whether that path currently
has a file at it or not (see "The API client" above for how that
distinction is drawn), and points at the real systemd **user** unit this
repo ships, `systemd/candlestix.service` — never a unit name copied from a
ticket or from an unrelated workspace's own `ENVIRONMENT.md` (which, on a
shared host, may well describe a *different* daemon entirely). Since it is
a user unit, checking it is `systemctl --user status candlestix.service`
and `journalctl --user -u candlestix.service` — the **system-level**
`journalctl -u candlestix.service` (no `--user`) prints `-- No entries --`
here, silently, rather than an error.

**The CLI never falls back to reading or writing the agent-set store
directly** — a reviewer can confirm this by the same grep as "no CLI logic
the API cannot express" above.

### Installing it, and the operator runbook

A `bin` entry (`package.json`'s `"bin": {"candlestix": "./src/cli/bin.ts"}`)
points at `src/cli/bin.ts`, which carries its own `#!/usr/bin/env bun`
shebang — verified locally (this story) to run directly when made
executable, with no bundling step required, since bun executes TypeScript
source natively. Nothing in the CLI was found to need any Bun/Node API
newer than what CNDLX-17/18 already relied on elsewhere in this tree
(`node:http`, `node:fs/promises`, `node:readline/promises`, `Bun.spawn`) —
each was checked to exist in Bun's own documented history at or before
1.3.11, though (see "Bun version" below) the floor itself could not be
run locally to confirm.

**Getting from today's laptop state to a working `candlestix`, for the
human — this has NOT been run on the laptop, and nobody should read it as
having been.** (CNDLX-31 ran the equivalent sequence for real, but on a
scratch host with scratch XDG dirs and a foreground daemon, never the
installed unit or the laptop itself — see "The real end-to-end
demonstration" below for what WAS actually run.)

1. `cd ~/code/brooswit-factory/candlestix && git pull` (or wherever the
   canonical checkout lives) to pick up this change once merged.
2. `bun install --frozen-lockfile`.
3. Restart the daemon's user unit so it starts serving the real,
   merged API: `systemctl --user restart candlestix.service`.
4. Put `candlestix` on `PATH`. Two ways that don't require root: `bun link`
   from the repo (creates a global bun-managed symlink), or a manual
   symlink of your own choosing, e.g.
   `ln -s ~/code/brooswit-factory/candlestix/src/cli/bin.ts ~/.local/bin/candlestix`
   (make sure `~/.local/bin` is on `PATH`, and that the target file is
   executable — `chmod +x`).
5. `candlestix` (bare) should create a blank agent and print the exact
   attach command. **Unrun on the laptop itself** — nobody should read
   this runbook as having been executed there — but this exact sequence
   of effects (create, attach, off survives a daemon restart, archive,
   delete) was run for real, end to end, against a real daemon and a
   real `claude --bg` session on a scratch host; see the PR description's
   transcript and "The real end-to-end demonstration" below.

### The real end-to-end demonstration (CNDLX-31)

Run against a **foreground** daemon (`bun run src/index.ts`, never the
installed unit) with **scratch** `XDG_CONFIG_HOME`/`XDG_STATE_HOME`/
`XDG_RUNTIME_DIR` under a short-lived `/tmp` directory (kept short — see
the sockaddr_un note below), driven entirely by the real CLI (`bun
src/cli/bin.ts ...`) and a real `claude --bg` session, attached through a
real pseudo-terminal. The full item-by-item transcript, each item with a
falsifier stated before it ran and an independent check (never the CLI's
own say-so — the durable store read directly, `claude agents --json`,
`claude logs`, `stat`), is in the PR description; this section records
only what it found:

- **The CLI reached the real daemon's actual bound socket**, not merely
  *some* socket: `apiSocketPath()` called from the CLI's own process
  printed the byte-identical path the daemon's own startup log recorded
  as what it bound, and every create/list/rename/etc. call's effect
  showed up in the daemon's own durable store file and in `claude
  agents --json`, both read independently of the CLI.
- **Every item in the ticket's checklist passed**: create; attach with a
  typed message independently confirmed in the session's own `claude
  logs`; detach with the session independently confirmed still running;
  rename with the directory's inode independently confirmed unchanged;
  off, then R6's no-change on repeat off (`turned off` vs `already off`,
  both exit `0`); off surviving a real daemon restart (SIGTERM, a fresh
  process, one reconcile cycle) with **zero** new sessions, independently
  checked (a **positive control** elsewhere in the same run — `on`
  genuinely spawning a session — rules out "the loop is just broken and
  never spawns anything"); on; archive hiding the agent from `list` while
  `--archived` shows it, proven with a **second, still-`on` control
  agent** so "empty list" cannot be mistaken for "list is just broken";
  attach refused while archived and while off (verbatim messages, exit
  `1`, and the off agent's store record independently confirmed to stay
  `off` — never silently started); delete refused without `--yes` on a
  non-TTY (directory independently confirmed still present) then deleting
  with `--yes` (directory independently confirmed gone, id retired); the
  two-terminal measurement (above).
- **The message-less-refusal fallback never fired** — `grep`, over the
  entire transcript, for its own telltale wording ("sent no message")
  found zero matches.
- **No stray session was left behind.** A final, unfiltered
  `claude agents --json` (no `--cwd` — the whole Unix user's sessions,
  including this host's live fleet of other agents' work) found 16
  sessions total and confirmed, as the **negative control**, that zero of
  them had a `cwd` under this run's scratch directory.
- **Two probe bugs were found and fixed during this run, neither a
  product defect** — named here per this project's own standing
  practice of debugging the probe before filing a surprising result: (1)
  an early independent-session check built the agent's directory path by
  stripping the `@` from its id (mimicking `agent-spawn.ts`'s *systemd
  unit name*, which does strip it — a different string with a different
  purpose); `agentDirectoryPath` does not, so the check found zero
  sessions where a real one existed until the path was corrected and
  re-run. (2) several early exit-code assertions captured `$?` after
  piping the command through `tee`, which captures `tee`'s exit code, not
  the CLI's; re-run without the pipe (or reading `$?` before any further
  command), every exit code matched what the unit tests already predicted.
- **`sockaddr_un` length**, per the epic's own recorded artifact: the
  scratch runtime directory was kept short (a plain `mktemp -d` under
  `/tmp`, not nested under this task's own deep workspace path) —
  measured at 47 bytes for the full socket path, comfortably under the
  ~108-byte limit; never needed the relative-path fallback the epic's
  note describes, but the margin was checked before relying on it, not
  assumed.

## H1/H2/H3 — CNDLX-18's three handoff findings, each explicitly handled

CNDLX-18 surfaced these during its own work, judged each out of its own
scope, and reported rather than silently fixed or dropped. Each is
addressed here, explicitly, per this story's own acceptance criteria:

- **H1 (the name-keyed session registry) — FIXED.** See "The registry"
  above: re-keyed from the agent's mutable name to its durable id, with a
  recognised-legacy-format file discarded under its own honest message
  rather than called malformed. The in-process heartbeat subject was
  re-keyed the same way, for the same reason (see `health/heartbeat.ts`
  above) — the same bug class, fixed in the same story for the same
  reason: both live in the exact modules this story rewrites anyway.

- **H2 (a transient `claude bg-pty-host --bg-spare` helper outliving
  `claude rm` by roughly 15-30s, observed once, not a measured bound) —
  HANDLED BY CONSTRUCTION, not by a wait or a postcondition check.** Under
  T2, this loop never stops or removes a session at all — it has no verb
  that could need "zero leftover candlestix processes" as a postcondition
  in the first place. It resurfaced, live, in this story's own
  verification *cleanup* (not in the product's own runtime) — see
  "Demonstrations" above — which is exactly why H2 flagged that any
  "nothing was left behind" assertion needs a second look rather than a
  glance, and this doc gives it one.

- **H3 (`store-write-failed` as a real staleness signal) — HANDLED, with
  the ruling stated explicitly.** See "What the loop does when the record
  disagrees with reality" above: the loop obeys the recorded state
  unconditionally and surfaces any disagreement as visibility (`wait` /
  `unexpected-session`), never as an inference that overrides the record.

## Known gaps — stated plainly, not implied away

- **The CLI's in-place attach is built AND verified against a real daemon
  — this bullet used to say "not built", then "resolves via a currently
  fake daemon query pending CNDLX-27", and is corrected here rather than
  left stale a second time.** `candlestix <id|name>` resolves through the
  real, merged `attach-target` query and hands the terminal to `claude
  attach <sessionShortId>`, both proven against a real daemon and a real
  `claude --bg` session (CNDLX-31 — see "The real end-to-end
  demonstration" above). Nothing about attach remains simulated.
- **Argv-drift correctness on wake is out of scope** (a separate epic).
  Not observed to be broken during this or prior stories' own testing, but
  candlestix does not defend against or detect drift if it ever occurs.
- **Reboot survival is proven structurally, not observed** — see "The
  reboot claim" above. This is a decision, stated at its exact strength,
  not a gap left unexamined.
- **Ambiguous adoption, scoped precisely (T5, see "Adoption keys on the
  directory" above):** two roster entries sharing a directory is retired
  by construction in candlestix's own minted-directory model; two live
  sessions sharing one directory is not, and is handled by `wait` rather
  than guessing.
- **The `wait` action is deliberately unbounded — this is a decision, not
  an oversight.** There is no consecutive-cycle counter and no escalation
  to spawning a replacement. The alternative — falling through to `spawn`
  after some bound of consecutive `wait`s — was considered and rejected:
  it can create a genuine duplicate background session next to one that
  was never actually dead, only slow to re-verify, which is a strictly
  worse failure than staying stuck. `wait` never fabricates health,
  either way: the heartbeat simply stops, the subject goes `stale`, and
  `startStalenessAlarm` gets loud on its own.
- **Nudge verification, startup-dialog answering (beyond the
  workspace-trust skip `--bg` already gets for free), and session-limit
  recognition are all out of scope.**
- **The lifecycle action set is now wired in (CNDLX-19) — this bullet
  used to say the opposite and is corrected here rather than left stale.**
  `src/index.ts`/`src/supervisor.ts` read the durable agent set every
  cycle; see "Supervisor loop" above.
- **`attach-target` and `open-terminal` are built and merged (CNDLX-32/33,
  `src/api/`).** R18's one query — resolve `<id-or-name>`, decide whether
  it is attachable right now, return the live session identity —
  including its short id. `open-terminal` runs the identical query, then
  an honest `not-implemented` naming CNDLX-3, which builds the real
  window-opening thing. The CLI's in-place attach (CNDLX-30/31) execs
  `claude attach <sessionShortId>` against this real query.
- **No webapp yet** — CNDLX-16's scope.
- **How an operator adds an MCP server to a daemon-created agent is
  unowned by any current story.** S6 gives every daemon-created agent an
  empty MCP config and keeps `--strict-mcp-config`; no verb or surface
  configures it yet. Deliberately not this task's either — CNDLX-26.
- **Bun version (CNDLX-20, resolved by CNDLX-27):** `engines.bun` is
  `>=1.3.11`, matching the target laptop, with a CI job (`check-floor` in
  `.github/workflows/ci.yml`) pinned to exactly `1.3.11` alongside the
  existing `latest` job — both run typecheck, test, and build.
- **Two attaches at once is correct, and candlestix does not arbitrate
  it** (see "The daemon API" above) — recorded here too since it reads
  like a gap at a glance and is in fact a deliberate ruling: what two
  simultaneous `claude attach` clients actually do is Claude Code's own
  behaviour, measured by CNDLX-31 below.
- **CNDLX-33's `invalid-job` refusal is enforced at `createAgent`
  (create-time), not at `spawnDaemonAgent` (every spawn).** R3 says `job`
  is set at create-only and nothing in this codebase mutates it after
  that, so this is sufficient for every path that ever calls
  `createAgent` — but the agent-set store's own deserializer
  (`agent-set.ts`) still accepts any string for `job`, including `""`, so
  a hand-edited `agents.json`, or a record created before this fix
  shipped, could still hold `job: ""` and would still reach spawn as
  `--append-system-prompt ""` the next time `turnOn` re-spawns it. Filed
  as CNDLX-34, destination CNDLX-2 (spawn-argv correctness) — not this
  task's to fix.

## Tooling

Bun as the runtime, package manager, and test runner (`bun test`), with
TypeScript in strict mode and `tsc --noEmit` as the typecheck gate. This
matches every other repo in `brooswit-factory` — none of them use a linter,
so this repo doesn't either; strictness comes from `tsconfig.json` instead
(`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`noImplicitOverride`). Zero runtime npm dependencies — `systemd-run`,
`claude`, and `kill(pid, 0)` are shelled out to / called via Node's own
`process.kill`, never installed as packages.

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

`.github/workflows/ci.yml` runs two jobs, both on every push, pull
request, and manual dispatch:

- **`check`** — `bun-version: latest`, runs `typecheck`, `test`, `build`.
- **`check-floor`** (CNDLX-20, added by this task) — pinned to exactly
  `bun-version: "1.3.11"`, running the identical three steps. **This is
  the load-bearing half of `engines.bun`'s `>=1.3.11` floor** — previously
  `engines.bun` said `>=1.3.14` while CI pinned only `latest`, so nothing
  ever actually tested the declared minimum; a regression against it
  would have passed CI regardless. A changed number with no gate pinned
  to it would just move the untested claim from one place to another,
  which is why this job, not the `engines` field, is the actual fix.
