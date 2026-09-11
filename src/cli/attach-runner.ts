// The ONE impure implementation of AttachDeps["spawnAttach"] (src/cli/attach.ts).
// Kept separate, exactly like this tree's other impure/pure splits (paths.ts
// vs xdg.ts, index.ts vs supervisor.ts), so every test drives the pure
// hand-off logic with a fake `spawnAttach` and never launches a real
// `claude` process.
export async function spawnClaudeAttach(sessionShortId: string): Promise<number> {
  const proc = Bun.spawn(["claude", "attach", sessionShortId], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await proc.exited;
}
