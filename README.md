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
consumers now: the reconcile loop reads exactly the state these verbs
write, and the daemon API (`src/api/`) is the one process that calls them
to mutate it. Still deliberately absent: no CLI, no webapp (CNDLX-28/16),
no real `open-terminal` implementation (CNDLX-3).

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
  unhandled rejection or a silently-stale record.

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
| 400 | `invalid-name`, `invalid-request-body`, `malformed-json` |
| 404 | `not-found` (unknown id-or-name), `unknown-route` |
| 409 | `ambiguous`, `name-taken`, `already-archived`, `archived`, `not-archived`, `off`, `no-live-session`, `multiple-live-sessions` — every state-conflict refusal |
| 501 | `not-implemented` (open-terminal, honestly) |
| 500 | `store-malformed`, `store-write-failed`, `session-lookup-failed`, `session-cleanup-failed`, `directory-create-failed`, `spawn-failed`, `directory-removal-failed` — daemon-side trouble, never the client's fault |

The exact mapping is `src/api/contract.ts`'s `statusForErrorKind`, a pure
function kept exhaustive over the same two kind-unions
`error-wire-format.ts` enumerates (see below) — a kind missing from either
fails `bun run typecheck`.

An **unknown route** or a **malformed JSON body** gets this same JSON
error shape, never an HTML page, an empty body, or a bare framework 404 —
see `test/unit/api/server.test.ts`.

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
actually do is Claude Code's own behaviour, measured by CNDLX-28, not
this task. Unlike the mutating verbs below, attach-target is **not**
run through the mutation queue.

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

- **No candlestix-specific attach convenience.** `claude attach <id>` /
  `logs <id>` / `stop <id>` work today against any agent candlestix
  spawned; a `candlestix`-side command that translates an agent's name to
  its current session id is a real, separate seam CNDLX-15 builds.
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
- **`attach-target` is built (CNDLX-32); the CLI's in-place attach is
  not.** `src/attach-target.ts` is R18's one query — resolve
  `<id-or-name>`, decide whether it is attachable right now, return the
  live session identity. What actually execs into a terminal in place is
  CNDLX-28's (the CLI), still to come. `open-terminal` (the daemon-opens-
  a-window path) is a seam, honestly: it runs the identical query, then an
  honest `not-implemented` naming CNDLX-3, which builds the real thing.
- **No CLI, no webapp** call any of this yet — CNDLX-28 and CNDLX-16's
  scope. The daemon HTTP API itself is built (CNDLX-32) — see "The daemon
  API" above.
- **How an operator adds an MCP server to a daemon-created agent is
  unowned by any current story.** S6 gives every daemon-created agent an
  empty MCP config and keeps `--strict-mcp-config`; no verb or surface
  configures it yet. Deliberately not this task's either — CNDLX-26.
- **Bun version (CNDLX-20, resolved by this task):** `engines.bun` is now
  `>=1.3.11`, matching the target laptop, with a CI job (`check-floor` in
  `.github/workflows/ci.yml`) pinned to exactly `1.3.11` alongside the
  existing `latest` job — both run typecheck, test, and build. This task's
  own suite, typecheck, and build were run against a REAL bun 1.3.11,
  installed into a scratch directory inside this task's own workspace by
  bun's own installer (an install directory + version tag, leaving the
  shared `bun` on `PATH` untouched) and invoked by full path — see the PR
  description for `<scratch>/bin/bun --version` printing `1.3.11`
  immediately beside that run. Nothing added by this task uses any Bun API
  not already verified to exist at 1.3.11 (`Bun.serve({unix})`,
  `fetch(url, {unix})`, and `Bun.connect({unix})` were each checked
  directly against a real 1.3.11 binary before being relied on).
- **Two attaches at once is correct, and candlestix does not arbitrate
  it** (see "The daemon API" above) — recorded here too since it reads
  like a gap at a glance and is in fact a deliberate ruling: what two
  simultaneous `claude attach` clients actually do is Claude Code's own
  behaviour, measured by CNDLX-28, not this task.

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
