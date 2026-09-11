import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiClient } from "../../../src/cli/api-client";
import { absentSocketPath, staleSocketPath, startFakeServer } from "./fake-server";

describe("createApiClient — the happy path, one per route", () => {
  test("createAgent: POST /v1/agents with the body, envelope round-trips", async () => {
    const server = await startFakeServer((req) => {
      expect(req.method).toBe("POST");
      expect(req.path).toBe("/v1/agents");
      expect(req.body).toEqual({ name: "foo", job: "watch PRs" });
      return { body: { ok: true, agent: { id: "@abc", name: "foo", state: "on", createdAt: "2026-01-01T00:00:00.000Z" } } };
    });
    try {
      const client = createApiClient({ socketPath: server.socketPath });
      const result = await client.createAgent({ name: "foo", job: "watch PRs" });
      expect(result).toEqual({
        transport: "ok",
        status: 200,
        body: { ok: true, agent: { id: "@abc", name: "foo", state: "on", createdAt: "2026-01-01T00:00:00.000Z" } },
      });
    } finally {
      await server.close();
    }
  });

  test("listAgents: GET /v1/agents, no body sent", async () => {
    const server = await startFakeServer((req) => {
      expect(req.method).toBe("GET");
      expect(req.path).toBe("/v1/agents");
      expect(req.body).toBeUndefined();
      return { body: { ok: true, agents: [] } };
    });
    try {
      const client = createApiClient({ socketPath: server.socketPath });
      const result = await client.listAgents();
      expect(result).toEqual({ transport: "ok", status: 200, body: { ok: true, agents: [] } });
    } finally {
      await server.close();
    }
  });

  test("lifecycleAction: POST /v1/agents/{idOrName}/{action}", async () => {
    const server = await startFakeServer((req) => {
      expect(req.method).toBe("POST");
      expect(req.path).toBe("/v1/agents/my-agent/off");
      return { body: { ok: true, outcome: { kind: "turned-off" } } };
    });
    try {
      const client = createApiClient({ socketPath: server.socketPath });
      const result = await client.lifecycleAction("my-agent", "off");
      expect(result).toEqual({ transport: "ok", status: 200, body: { ok: true, outcome: { kind: "turned-off" } } });
    } finally {
      await server.close();
    }
  });

  test("renameAgent: POST /v1/agents/{idOrName}/rename with the new name in the body", async () => {
    const server = await startFakeServer((req) => {
      expect(req.path).toBe("/v1/agents/my-agent/rename");
      expect(req.body).toEqual({ name: "new-name" });
      return { body: { ok: true, agent: { id: "@abc", name: "new-name", state: "on", createdAt: "x" } } };
    });
    try {
      const client = createApiClient({ socketPath: server.socketPath });
      const result = await client.renameAgent("my-agent", { name: "new-name" });
      expect(result.transport).toBe("ok");
    } finally {
      await server.close();
    }
  });

  test("attachTarget: GET /v1/agents/{idOrName}/attach-target", async () => {
    const server = await startFakeServer((req) => {
      expect(req.method).toBe("GET");
      expect(req.path).toBe("/v1/agents/my-agent/attach-target");
      return { body: { ok: true, agentId: "@abc", sessionShortId: "sess1", sessionId: "sess1-full" } };
    });
    try {
      const client = createApiClient({ socketPath: server.socketPath });
      const result = await client.attachTarget("my-agent");
      expect(result.transport).toBe("ok");
    } finally {
      await server.close();
    }
  });
});

describe("createApiClient — URL-encoding of {idOrName}", () => {
  test("a name needing encoding (space and slash) reaches the daemon correctly encoded", async () => {
    const server = await startFakeServer((req) => {
      // decodeURIComponent of the recorded path segment must round-trip to
      // the original name — this is the actual proof of encoding, not just
      // "no crash".
      const segment = req.path.split("/")[3] as string;
      expect(decodeURIComponent(segment)).toBe("weird name/with slash");
      return { body: { ok: true, outcome: { kind: "turned-on" } } };
    });
    try {
      const client = createApiClient({ socketPath: server.socketPath });
      const result = await client.lifecycleAction("weird name/with slash", "on");
      expect(result.transport).toBe("ok");
      // Negative control: an UNENCODED slash would have split into an extra
      // path segment, and the recorded path would then have MORE than 5
      // "/"-separated parts. Prove it does not.
      const recordedPath = server.requests[0]?.path as string;
      expect(recordedPath.split("/").length).toBe(5); // "", "v1", "agents", "<encoded name>", "on"
    } finally {
      await server.close();
    }
  });
});

describe("createApiClient — daemon-unreachable, distinguishing absent from present-but-refused", () => {
  test("no socket file at all: reported as unreachable, socketFilePresent is false", async () => {
    const { socketPath, cleanup } = await absentSocketPath();
    try {
      const client = createApiClient({ socketPath });
      const result = await client.listAgents();
      expect(result.transport).toBe("unreachable");
      if (result.transport === "unreachable") {
        expect(result.socketFilePresent).toBe(false);
        expect(result.socketPath).toBe(socketPath);
      }
    } finally {
      await cleanup();
    }
  });

  test("a stale socket file (was listening, died, file left behind): reported as unreachable, socketFilePresent is true", async () => {
    const { socketPath, cleanup } = await staleSocketPath();
    try {
      const client = createApiClient({ socketPath });
      const result = await client.listAgents();
      expect(result.transport).toBe("unreachable");
      if (result.transport === "unreachable") {
        expect(result.socketFilePresent).toBe(true);
      }
    } finally {
      await cleanup();
    }
  });

  test("negative control: the SAME socket path, while a real fake server IS listening, is transport 'ok' — proves the unreachable cases above are not just 'always unreachable'", async () => {
    const server = await startFakeServer(() => ({ body: { ok: true, agents: [] } }));
    try {
      const client = createApiClient({ socketPath: server.socketPath });
      const result = await client.listAgents();
      expect(result.transport).toBe("ok");
    } finally {
      await server.close();
    }
  });
});

describe("createApiClient — protocol-level trouble, distinct from an ordinary API refusal", () => {
  test("a non-JSON response body is a protocol-error, not silently treated as a refusal or a crash", async () => {
    const dir = await mkdtemp(join(tmpdir(), "candlestix-cli-badjson-"));
    const socketPath = join(dir, "candlestix.sock");
    const server = Bun.serve({
      unix: socketPath,
      fetch: () => new Response("<html>not json</html>", { status: 200, headers: { "content-type": "text/html" } }),
    });
    try {
      const client = createApiClient({ socketPath });
      const result = await client.listAgents();
      expect(result.transport).toBe("protocol-error");
    } finally {
      server.stop(true);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a JSON response missing the 'ok' envelope field is a protocol-error", async () => {
    const server = await startFakeServer(() => ({ body: { agents: [] } })); // no "ok" field at all
    try {
      const client = createApiClient({ socketPath: server.socketPath });
      const result = await client.listAgents();
      expect(result.transport).toBe("protocol-error");
    } finally {
      await server.close();
    }
  });
});
