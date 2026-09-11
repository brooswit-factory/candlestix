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
`archive`/`unarchive`/`delete`/`list`, `src/agent-actions.ts`) now has a
consumer: the reconcile loop reads exactly the state these verbs write.

**CNDLX-30 (this story's task) added the `candlestix` CLI** — grammar, a
thin HTTP-over-Unix-socket client, in-place attach, a confirming delete,
exit codes, README and runbook. See "The candlestix CLI" below for what it
is and, just as importantly, what it is **not yet**: it is built against a
**temporary, local restatement** of CNDLX-27's daemon API contract
(`src/api-contract.ts`), because CNDLX-27 (the daemon API itself — the
socket, the routes, the real wire types) is being built in parallel and has
not merged. **There is still no real daemon API in this tree, no HTTP
server, and no socket anyone is listening on** — the CLI's own test suite
talks only to a fake server on a temp Unix socket it starts itself. The
real end-to-end demonstration against a real daemon and a real `claude --bg`
session is CNDLX-31's job, after CNDLX-27 merges and this CLI rebases onto
its real contract module. No webapp yet (CNDLX-16); the daemon-opens-a-window
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
reads** — see "Supervisor loop" above. Still no CLI, no HTTP, no API, no
UI (CNDLX-15's scope), and `attach` is still not built (CNDLX-3's scope,
left a seam).

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
  unhandled rejection or a silently-stale record.

## The candlestix CLI (`src/cli/`, `src/api-contract.ts`)

CNDLX-30's task: the human-facing surface. **`candlestix` is a thin client
of the daemon API — it never touches the store, the agent set, or any
action/lifecycle module directly.** Every state-changing thing it does goes
out over HTTP, on a Unix domain socket, to the daemon. A reviewer can check
this by grep: nothing under `src/cli/` or in `src/api-contract.ts` imports
`agent-actions.ts`, `agent-set.ts`, `agent-set-store.ts`, `agent-resolver.ts`,
`agent-session.ts`, `agent-spawn.ts`, `agent-directory.ts` or `agent-id.ts` —
the one exception, `src/agent.ts`'s `AgentRecord` **type**, is imported
type-only, for the wire shape, never as a runtime value.

### The temporary contract module — read this before touching anything else here

**`src/api-contract.ts` does not belong to this story.** The daemon API —
its socket, its routes, its wire types — is CNDLX-27's story, built in
parallel with this one and not yet merged as this CLI was written. This
file is CNDLX-30's own best-effort restatement of that contract: a socket
path resolver, the route table, and the wire envelope/success types, all
guessed or restated rather than verified against a real server (none
exists yet). **Every other CLI module imports contract-shaped things ONLY
from this one file.**

**When CNDLX-27 merges, CNDLX-31 (a later task, not this one) deletes this
file outright** and repoints every one of those imports at CNDLX-27's real
contract module, reconciling field names (attach-target's response shape
most of all — this file's version is a guess) against what actually
shipped. That swap should touch imports only, never grammar, rendering, or
the test suite's behavioural expectations.

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

### Rendering and the message-less-refusal fallback (`src/cli/render.ts`)

**R8, applied here:** `error.message` is printed verbatim whenever present
— never the CLI's own wording for a refusal. **The one guard this story
adds on top of that (the epic's explicit requirement):** if a refusal
arrives with no `message` at all, the CLI prints exactly one generic line
naming the `kind` and saying the daemon sent no message, rather than
inventing per-kind wording of its own. This is unit-tested (including a
negative control: two different missing-message kinds render two
different lines, proving it is not a fixed string). **It is expected NEVER
to fire against CNDLX-27's real, merged server** — CNDLX-27 is tasked with
ensuring every wire error carries a server-produced message. If this
branch is ever observed to fire against a real daemon, that is a CNDLX-27
defect to report, never something to quietly paper over here.

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
4. **Not measured here, and not claimed:** what `claude attach --help`
   prints on any host other than the one this story ran on, actual detach
   behaviour, and two simultaneous attaches to the same session. All three
   need a real `claude --bg` session and belong to CNDLX-31.

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
| `1` | a refusal — the daemon's `error.message` verbatim, a CLI-side policy refusal (attach's non-TTY check, delete's confirmation refusal or decline) | candlestix |
| `2` | a usage error (bad grammar) | candlestix |
| `3` | the daemon is unreachable, or its response could not be understood | candlestix |

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
having been:**

1. `cd ~/code/brooswit-factory/candlestix && git pull` (or wherever the
   canonical checkout lives) to pick up this change once merged.
2. `bun install --frozen-lockfile`.
3. Restart the daemon's user unit so it starts serving the API once
   CNDLX-27 has merged and this CLI has rebased onto it (CNDLX-31):
   `systemctl --user restart candlestix.service`.
4. Put `candlestix` on `PATH`. Two ways that don't require root: `bun link`
   from the repo (creates a global bun-managed symlink), or a manual
   symlink of your own choosing, e.g.
   `ln -s ~/code/brooswit-factory/candlestix/src/cli/bin.ts ~/.local/bin/candlestix`
   (make sure `~/.local/bin` is on `PATH`, and that the target file is
   executable — `chmod +x`).
5. `candlestix` (bare) should create a blank agent and print the exact
   attach command; **this step, and every step above it, is unrun** — the
   real end-to-end demonstration against a real daemon is CNDLX-31's job,
   after CNDLX-27 merges.

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

- **CNDLX-30 built the CLI's in-place attach — this bullet used to say
  "not built" and is corrected here rather than left stale.** `candlestix
  <id|name>` now resolves via a (currently fake, pending CNDLX-27) daemon
  query and hands the terminal to `claude attach <sessionShortId>`. See
  "The candlestix CLI" above. What is still genuinely missing: a **real**
  daemon to query (CNDLX-27, not merged) and the real end-to-end
  demonstration against one (CNDLX-31).
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
- **`attach` as a daemon-owned query (in core, over the wire) is still not
  built — that is CNDLX-27, not this repo's `main` yet.** `agent-session.ts`'s
  `findAgentSessions` remains the in-process lookup half CNDLX-27 will
  build the query on top of. The **window-opening** form of attach
  (CNDLX-3, webapp-only) is separately still not built either way.
- **No real HTTP daemon API and no webapp yet.** CNDLX-30 (this task)
  built the CLI half of CNDLX-15 — grammar, client, attach hand-off,
  confirming delete — against a **temporary, local restatement**
  (`src/api-contract.ts`) of the contract CNDLX-27 owns; CNDLX-27 itself
  (the real socket, routes, and server) has not merged. No webapp yet
  either (CNDLX-16).
- **How an operator adds an MCP server to a daemon-created agent is
  unowned by any current story.** S6 gives every daemon-created agent an
  empty MCP config and keeps `--strict-mcp-config`; no verb or surface
  configures it yet.
- **Bun version**: this story's own suite, typecheck, and build were run
  on bun **1.3.14** — see "Demonstrations" above for the exact numbers.
  The target laptop runs bun 1.3.11 (tracked as CNDLX-20, owned by
  CNDLX-27, not this story); nothing added by this story relies on any
  bun API newer than what CNDLX-17/CNDLX-18 already used
  (`node:fs/promises`, `node:path`, `node:crypto`, `Bun.spawn`,
  `JSON`/`Map`/`Set` — all already in use elsewhere in this tree before
  this story).
- **CNDLX-30 (the CLI) adds three more runtime surfaces, and could not run
  any of them at the 1.3.11 floor either — the same situation CNDLX-27's
  own task reported, for the same reason (only bun 1.3.14 was available on
  this host).** `node:http`'s `socketPath` client option, `node:readline/
  promises`, and `Bun.spawn` with `stdio: "inherit"` were each exercised
  successfully at 1.3.14 (the CLI's own test suite proves the first
  directly, against a fake `Bun.serve({unix, fetch})` server; the other two
  were checked with standalone smoke scripts, not committed test code,
  since they touch a real TTY/process rather than the fake-server harness
  this suite otherwise uses throughout). None are newer additions to the
  Bun/Node API surface than what CNDLX-17–19 already relied on elsewhere in
  this tree. **Whether all three genuinely work at exactly 1.3.11 remains
  unverified** — the pinned-CI job CNDLX-27/CNDLX-20 is adding is the actual
  gate for that claim, same as for the rest of this tree.

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

`.github/workflows/ci.yml` runs `typecheck`, `test`, and `build` on every
push, pull request, and manual dispatch. Note a standing blind spot:
`engines.bun` in `package.json` is `>=1.3.14` (the roster used to rely on
Bun's built-in `Bun.YAML`; nothing in the current tree still does, but the
floor has not been lowered), while CI pins `bun-version: latest`, so **CI
structurally cannot verify that floor** — a regression against the stated
minimum would pass CI regardless. This predates this story and is
unchanged by it.
