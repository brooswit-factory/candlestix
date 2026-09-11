// CNDLX-27 section 4 / CNDLX-3: the daemon opening a terminal window on the
// operator's desktop is webapp-only (the human's correction of 2026-09-10)
// and is CNDLX-3's to implement. This module defines the endpoint's
// contract so CNDLX-16 has something to call, honestly, before CNDLX-3
// exists:
//
// - It runs the SAME attach-target query first (attach-target.ts), so
//   not-found, off, archived, zero-session and multi-session refusals are
//   byte-for-byte identical to attach-target's own — shared code, never
//   restated branches that could drift apart.
// - Only when that query would have SUCCEEDED does this return a typed
//   `not-implemented` refusal, honestly naming CNDLX-3 as the epic that
//   builds the real thing. Never a stub that pretends to work.
// - Named `open-terminal`, deliberately not "attach", so no later reader
//   confuses this daemon-opens-a-window path with the CLI's in-place
//   attach (CNDLX-28). Reserved in agent-lifecycle.ts's ONE reserved-name
//   list, per R17's standing rule: whoever names a new verb reserves it at
//   the same moment.

import { getAttachTarget, type AttachTargetDeps, type AttachTargetError } from "./attach-target";

export type OpenTerminalError = AttachTargetError | { kind: "not-implemented"; epic: "CNDLX-3"; message: string };

/** Never `ok: true` today — see the module doc. The type still carries the shape CNDLX-3 will fill in, so a future implementation is additive, not a breaking wire change. */
export type OpenTerminalResult = { ok: false; error: OpenTerminalError };

export async function getOpenTerminalTarget(deps: AttachTargetDeps, query: string): Promise<OpenTerminalResult> {
  const attached = await getAttachTarget(deps, query);
  if (!attached.ok) {
    // Identical refusal to attach-target's own — not restated, not
    // re-derived, the exact same typed value attach-target would have
    // returned for this query.
    return attached;
  }
  return {
    ok: false,
    error: {
      kind: "not-implemented",
      epic: "CNDLX-3",
      message: `opening a terminal window is not built yet — CNDLX-3 implements it. The agent is attachable right now (session "${attached.target.sessionShortId}"); until CNDLX-3 ships, attach in place instead (the CLI's own attach, CNDLX-28) rather than through this endpoint.`,
    },
  };
}
