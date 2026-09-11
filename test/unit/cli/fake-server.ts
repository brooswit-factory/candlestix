// Shared test harness: a scriptable HTTP server on a temp Unix socket,
// standing in for CNDLX-27's real daemon API. Every CLI test that needs a
// server uses this — never real state, never a real daemon, scratch dirs
// only, per this story's own DoD.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

export interface ScriptedResponse {
  status?: number;
  body: unknown;
}

export interface FakeServerHandle {
  socketPath: string;
  requests: RecordedRequest[];
  /** Stops accepting connections. Does not remove the socket file (so a "present but refused" scenario can be built on top of this if a test wants one). */
  stopAccepting: () => void;
  /** Stops the server and removes its scratch directory (including the socket file). */
  close: () => Promise<void>;
}

export async function startFakeServer(handler: (req: RecordedRequest) => ScriptedResponse): Promise<FakeServerHandle> {
  const dir = await mkdtemp(join(tmpdir(), "candlestix-cli-fake-"));
  const socketPath = join(dir, "candlestix.sock");
  const requests: RecordedRequest[] = [];

  const server = Bun.serve({
    unix: socketPath,
    async fetch(req) {
      const url = new URL(req.url);
      const text = await req.text();
      let body: unknown = undefined;
      if (text.length > 0) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      const recorded: RecordedRequest = { method: req.method, path: url.pathname, body };
      requests.push(recorded);
      const scripted = handler(recorded);
      return new Response(JSON.stringify(scripted.body), {
        status: scripted.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  return {
    socketPath,
    requests,
    stopAccepting: () => server.stop(true),
    close: async () => {
      server.stop(true);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** A path under a fresh scratch directory where nothing has ever listened — the "never started" daemon-down case. */
export async function absentSocketPath(): Promise<{ socketPath: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "candlestix-cli-absent-"));
  return { socketPath: join(dir, "candlestix.sock"), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/**
 * A file present at the socket path with nothing accepting connections on
 * it — the "died, left a file behind" daemon-down case, distinct from
 * "never started". A real Unix-domain listener's `close()` was verified
 * (locally, this story) to unlink its own socket file on this runtime, so
 * that path cannot be used to produce a genuinely orphaned socket inode;
 * a plain regular file at the same path produces the identical observable
 * client behaviour (stat sees a present file; a connection attempt fails)
 * without depending on that unlink-on-close behaviour holding forever.
 */
export async function staleSocketPath(): Promise<{ socketPath: string; cleanup: () => Promise<void> }> {
  const { writeFile } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "candlestix-cli-stale-"));
  const socketPath = join(dir, "candlestix.sock");
  await writeFile(socketPath, "");
  return { socketPath, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
