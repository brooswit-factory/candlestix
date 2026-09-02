// Thin child-process runner shared by agents-cli.ts (listing) and
// spawn.ts (launching). Argv-array based throughout candlestix — never a
// shell string — so an operator's job description or any other
// roster-derived value can contain arbitrary text (quotes, `$`, backticks,
// newlines) without any escaping concern: it is handed to execve as one
// argv element, never interpreted by a shell.
export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunCommandOptions {
  cwd?: string;
  timeoutMs: number;
}

/**
 * Runs `argv[0]` with `argv.slice(1)` as arguments. On timeout, kills the
 * process and rejects — this is what stands between one hung `claude`/
 * `systemd-run` invocation and the whole reconcile cycle stalling forever,
 * since every agent is reconciled concurrently (see supervisor.ts) and a
 * per-agent await must have a bound.
 */
export async function runCommand(argv: string[], options: RunCommandOptions): Promise<CommandResult> {
  const [cmd, ...args] = argv;
  if (cmd === undefined) {
    throw new Error("runCommand: argv must have at least one element");
  }

  const proc = Bun.spawn([cmd, ...args], {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, options.timeoutMs);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (timedOut) {
      throw new Error(`command timed out after ${options.timeoutMs}ms: ${argv.join(" ")}`);
    }

    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}
