// Manual verification harness for the self-firing staleness alarm and the
// external health signal — NOT part of `bun test`, and deliberately so: a
// unit test asserting a mock callback was invoked cannot prove a real
// timer in a real running process actually fires, or that a real subject
// that was never tracked really does produce silence rather than a
// suppressed error. This script proves both by actually running it,
// exactly as scar tissue #3 in the ticket demands.
//
// Run it with:
//   bun run scripts/verify-alarm.ts
//
// Optional overrides (milliseconds):
//   THRESHOLD_MS=500 ALARM_INTERVAL_MS=200 RUN_MS=2000 bun run scripts/verify-alarm.ts
//
// What this sets up, and what to expect:
//
//   - "demo-tracked-loop" gets exactly ONE heartbeat, then none again. It
//     starts healthy and crosses the threshold partway through the run.
//     EXPECT: one real ERROR-level log line naming "demo-tracked-loop" as
//     STALE, appearing on the alarm's own schedule, well before the
//     script exits — nobody polls for it.
//
//   - "demo-untracked-subject" is a name this script never registers and
//     never heartbeats at all — it does not exist in the store. It is
//     printed below so you know what to look for, but nothing in this
//     process ever tells the store it exists.
//     EXPECT: NO log line ever mentions "demo-untracked-subject", and the
//     health signal file (path printed below) NEVER contains an entry for
//     it either, in any of its periodic rewrites. Its absence from that
//     file is the honest answer — a fabricated "stale" entry for it would
//     be the second scar-tissue bug this ticket exists to prevent.
//
//   - The process exits ON ITS OWN once both timers are stopped — no
//     `process.exit()` call anywhere in this script. If the process hung
//     instead of exiting, or exited immediately without ever logging, one
//     of the two capabilities would be fake; watch for either.
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHeartbeatStore } from "../src/health/heartbeat";
import { startStalenessAlarm } from "../src/health/alarm";
import { startHealthSignalWriter } from "../src/health/signal";
import { log } from "../src/log";

const THRESHOLD_MS = Number(process.env["THRESHOLD_MS"] ?? 500);
const ALARM_INTERVAL_MS = Number(process.env["ALARM_INTERVAL_MS"] ?? 200);
const SIGNAL_INTERVAL_MS = ALARM_INTERVAL_MS;
const RUN_MS = Number(process.env["RUN_MS"] ?? 2000);

const TRACKED_SUBJECT = "demo-tracked-loop";
const UNTRACKED_SUBJECT = "demo-untracked-subject";

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "candlestix-health-demo-"));
  const signalPath = join(dir, "health.json");

  log("info", `threshold=${THRESHOLD_MS}ms alarm-interval=${ALARM_INTERVAL_MS}ms run=${RUN_MS}ms`);
  log("info", `health signal file: ${signalPath}`);
  log("info", `tracked subject "${TRACKED_SUBJECT}" gets one heartbeat now, then none again — watch it go stale`);
  log("info", `"${UNTRACKED_SUBJECT}" is never registered or heartbeaten — watch for its total absence`);

  const store = createHeartbeatStore();
  store.recordHeartbeat(TRACKED_SUBJECT);

  const alarm = startStalenessAlarm({ store, intervalMs: ALARM_INTERVAL_MS, thresholdMs: THRESHOLD_MS });
  const signal = startHealthSignalWriter({
    store,
    path: signalPath,
    intervalMs: SIGNAL_INTERVAL_MS,
    thresholdMs: THRESHOLD_MS,
  });

  await new Promise((resolve) => setTimeout(resolve, RUN_MS));

  const finalSignal = JSON.parse(await readFile(signalPath, "utf8"));
  log("info", `final health signal contents: ${JSON.stringify(finalSignal)}`);
  const namesUntracked = finalSignal.subjects.some((s: { subjectId: string }) => s.subjectId === UNTRACKED_SUBJECT);
  log(
    namesUntracked ? "error" : "info",
    namesUntracked
      ? `FAIL: the health signal fabricated an entry for "${UNTRACKED_SUBJECT}", which was never tracked`
      : `confirmed: "${UNTRACKED_SUBJECT}" never appears in the health signal — silence, not a fabricated verdict`
  );

  log("info", "stopping both timers now; the process should exit on its own from here, with no process.exit() call");
  alarm.stop();
  signal.stop();
}

main();
