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
`SIGINT` / `SIGTERM` — it does not yet keep any agents alive. The roster, the
health/heartbeat components, and the supervisor loop that actually make it a
daemon are separate, later stories.

## Intended layout

The entrypoint (`src/index.ts`) is kept deliberately small so that each of
the following can be added as a new module plus a couple of wired-in calls,
rather than a rewrite:

- **Roster** — the source of truth for which agents should exist and how to
  reach them, replacing the JQL-query-based discovery `butchr` uses.
- **Health** — an honestly-positive heartbeat per agent (no lying "idle" or
  fake-healthy defaults).
- **Supervisor loop** — reconciles the roster against reality: starts
  missing agents, detects drift, restores after a machine reboot.

`src/log.ts` is the one piece of shared infrastructure that already exists
ahead of those modules — a pure log-line formatter every future module can
call into, proven by a real unit test in `test/unit/`.

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
