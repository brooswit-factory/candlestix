// Direct OS-level liveness check, deliberately independent of any
// third-party registry's say-so (`claude agents --json` included) — per
// this ticket's guidance that direct observation of the OS is a stronger
// source than a registry, even one candlestix mostly trusts.
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is owned by someone else — still
    // alive, just not signalable by us. Any other error (ESRCH, chiefly)
    // means it does not exist.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
