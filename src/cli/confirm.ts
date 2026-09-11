// delete's confirmation policy (the CLI's own concern — the API's delete is
// the action itself; the webapp confirms separately). Pure given its
// injected I/O, so the whole confirmation matrix is unit-testable without a
// fake server: TTY affirmative, TTY declined, `--yes`, non-TTY without
// `--yes` (refused), non-TTY with `--yes`.

export interface ConfirmDeps {
  stdinIsTTY: boolean;
  /** Writes `promptText` and resolves with one line of input. Called ONLY when `stdinIsTTY` is true — never on a non-TTY stdin, which would hang waiting for input that will never arrive. */
  promptAndReadLine: (promptText: string) => Promise<string>;
}

export type ConfirmOutcome = { kind: "proceed" } | { kind: "declined" } | { kind: "refused"; message: string };

/**
 * `--yes`/`-y` always short-circuits, TTY or not (the documented
 * non-interactive escape hatch). Absent that, a non-TTY stdin is refused
 * outright — prompting would hang waiting for input a script will never
 * supply, and "defaulting to yes there is how a pipeline wipes an agent
 * set" (the ticket's own words). Only a genuine TTY gets prompted, and
 * only an explicit "y"/"yes" (case-insensitive, trimmed) counts as
 * affirmative — a bare Enter is deliberately NOT one.
 */
export async function resolveDeleteConfirmation(
  params: { yes: boolean; agentDescription: string },
  deps: ConfirmDeps
): Promise<ConfirmOutcome> {
  if (params.yes) return { kind: "proceed" };

  if (!deps.stdinIsTTY) {
    return {
      kind: "refused",
      message: `candlestix: refusing to delete ${params.agentDescription} without confirmation: stdin is not a TTY. Pass --yes/-y to confirm non-interactively.`,
    };
  }

  const answer = (
    await deps.promptAndReadLine(
      `Delete ${params.agentDescription}? This removes its directory and conversation and retires its id. Type "yes" to confirm: `
    )
  )
    .trim()
    .toLowerCase();

  if (answer === "y" || answer === "yes") return { kind: "proceed" };
  return { kind: "declined" };
}
