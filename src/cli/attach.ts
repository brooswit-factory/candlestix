// The attach hand-off: R18's "the terminal is the caller's concern, and
// that caller is you." Given a resolved session's short id, either refuse
// deliberately (non-TTY) or hand the terminal over and propagate whatever
// exit status comes back. No daemon round trip happens in this module —
// resolving the attach target is the caller's job (src/cli/api-client.ts's
// `attachTarget`), called once, before this module ever runs.

export interface AttachDeps {
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  /** Runs `claude attach <sessionShortId>` with stdio inherited, and resolves with the child's own exit code. Real implementation: src/cli/attach-runner.ts. */
  spawnAttach: (sessionShortId: string) => Promise<number>;
}

export type AttachHandoffResult = { kind: "refused-non-tty"; message: string } | { kind: "handed-off"; exitCode: number };

/**
 * Bun (like Node) cannot replace the current process image the way a Unix
 * `exec()` would — there is no such primitive on this runtime. The
 * fallback the ticket itself sanctions is taken instead: spawn with every
 * stream inherited, wait for the child, and propagate its exit code
 * exactly. From the operator's terminal, inherited stdio makes this
 * indistinguishable from an in-place attach; the only observable
 * difference is one extra (invisible) parent process for the lifetime of
 * the session.
 */
export async function performAttachHandoff(sessionShortId: string, deps: AttachDeps): Promise<AttachHandoffResult> {
  if (!deps.stdinIsTTY || !deps.stdoutIsTTY) {
    return {
      kind: "refused-non-tty",
      message:
        "candlestix: refusing to attach — both stdin and stdout must be a TTY. `claude attach` is interactive; attaching from a non-interactive context would hang rather than do anything useful. Attach from an interactive terminal instead.",
    };
  }
  const exitCode = await deps.spawnAttach(sessionShortId);
  return { kind: "handed-off", exitCode };
}
