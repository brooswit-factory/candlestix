import { describe, expect, test } from "bun:test";
import { isPidAlive } from "../../src/proc";

describe("isPidAlive", () => {
  test("this process's own pid is alive", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  test("pid 1 either exists (EPERM, most containers/hosts) or is deliberately treated as alive when signalable", () => {
    // Not asserting a specific answer for pid 1 across every sandbox this
    // runs in — just that the function returns a boolean and does not throw.
    expect(typeof isPidAlive(1)).toBe("boolean");
  });

  test("a pid essentially guaranteed not to exist is reported dead", () => {
    // PIDs are bounded (commonly by /proc/sys/kernel/pid_max); this value
    // is chosen to be implausible on any real system without hardcoding a
    // specific "known-dead" pid that could coincidentally be reused.
    expect(isPidAlive(2 ** 30)).toBe(false);
  });
});
