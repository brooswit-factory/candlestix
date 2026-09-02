import { describe, expect, test } from "bun:test";
import { parseRoster } from "../../src/roster";

function expectOk(result: ReturnType<typeof parseRoster>) {
  if (!result.ok) {
    throw new Error(`expected ok:true, got errors: ${JSON.stringify(result.errors, null, 2)}`);
  }
  return result;
}

function expectErr(result: ReturnType<typeof parseRoster>) {
  if (result.ok) {
    throw new Error(`expected ok:false, got roster: ${JSON.stringify(result.roster, null, 2)}`);
  }
  return result;
}

describe("parseRoster", () => {
  test("valid roster with multiple entries: full result asserted, block-scalar job keeps newlines, passthrough mcp key survives", () => {
    const source = `
agents:
  - name: a1
    job: |
      line one
      line two
    cwd: /home/op/a1
    mcpServers:
      fs:
        command: mcp-fs
        args: ["--root", "/tmp"]
        env:
          TOKEN: "abc"
        somePassthroughKey: 42
  - name: a2
    job: single line job
    cwd: /home/op/a2
    mcpServers: {}
`;
    // Fails if: the parser drops an entry, mangles the job's newlines, strips
    // the unrecognised "somePassthroughKey" from the mcp server config, or
    // returns ok:false for input that satisfies every rule.
    const result = expectOk(parseRoster(source));
    expect(result.roster).toEqual({
      agents: [
        {
          name: "a1",
          job: "line one\nline two\n",
          cwd: "/home/op/a1",
          mcpServers: {
            fs: {
              command: "mcp-fs",
              args: ["--root", "/tmp"],
              env: { TOKEN: "abc" },
              somePassthroughKey: 42,
            },
          },
        },
        {
          name: "a2",
          job: "single line job",
          cwd: "/home/op/a2",
          mcpServers: {},
        },
      ],
    });
  });

  test("agents: [] is a valid roster with zero entries", () => {
    // Fails if: an empty agents list is rejected, or the returned roster has
    // any entries.
    const result = expectOk(parseRoster("agents: []\n"));
    expect(result.roster).toEqual({ agents: [] });
  });

  test("empty source is rejected", () => {
    // Fails if: an empty string is accepted (ok:true).
    expectErr(parseRoster(""));
  });

  test("whitespace-only source is rejected", () => {
    // Fails if: a whitespace-only string is accepted (ok:true).
    expectErr(parseRoster("   \n\t\n  "));
  });

  test("missing agents key is rejected with a message naming what was expected", () => {
    // Fails if: the result is ok:true, or no error mentions "agents".
    const result = expectErr(parseRoster("foo: bar\n"));
    expect(result.errors.some((e) => e.message.includes("agents"))).toBe(true);
  });

  test("agents present but not a list is rejected", () => {
    // Fails if: a non-list `agents` value is accepted, or no error mentions "agents".
    const result = expectErr(parseRoster("agents: not-a-list\n"));
    expect(result.errors.some((e) => e.message.includes("agents"))).toBe(true);
  });

  test("malformed YAML is rejected via ok:false, and does not throw", () => {
    // Fails if: calling parseRoster on genuinely malformed YAML throws
    // instead of returning, or returns ok:true.
    let result: ReturnType<typeof parseRoster> | undefined;
    expect(() => {
      result = parseRoster("agents: [1, 2\nfoo: [bar");
    }).not.toThrow();
    expectErr(result!);
  });

  const validEntry = {
    name: "a1",
    job: "does things",
    cwd: "/home/op/a1",
    mcpServers: {},
  };

  function rosterWith(overrides: Record<string, unknown>): string {
    const entry = { ...validEntry, ...overrides };
    return Bun.YAML.stringify({ agents: [entry] });
  }

  test("missing name is rejected", () => {
    const { name, ...rest } = validEntry;
    // Fails if: an entry with no "name" field is accepted.
    const result = expectErr(parseRoster(Bun.YAML.stringify({ agents: [rest] })));
    expect(result.errors.some((e) => e.field === "name")).toBe(true);
  });

  test("missing job is rejected", () => {
    const { job, ...rest } = validEntry;
    // Fails if: an entry with no "job" field is accepted.
    const result = expectErr(parseRoster(Bun.YAML.stringify({ agents: [rest] })));
    expect(result.errors.some((e) => e.field === "job")).toBe(true);
  });

  test("missing cwd is rejected", () => {
    const { cwd, ...rest } = validEntry;
    // Fails if: an entry with no "cwd" field is accepted.
    const result = expectErr(parseRoster(Bun.YAML.stringify({ agents: [rest] })));
    expect(result.errors.some((e) => e.field === "cwd")).toBe(true);
  });

  test("missing mcpServers is rejected", () => {
    const { mcpServers, ...rest } = validEntry;
    // Fails if: an entry with no "mcpServers" field is accepted.
    const result = expectErr(parseRoster(Bun.YAML.stringify({ agents: [rest] })));
    expect(result.errors.some((e) => e.field === "mcpServers")).toBe(true);
  });

  test("duplicate agent names are rejected, error names the duplicate", () => {
    const source = Bun.YAML.stringify({
      agents: [
        { ...validEntry, name: "dup" },
        { ...validEntry, name: "dup" },
      ],
    });
    // Fails if: two entries with the same name are both accepted, or no
    // error message mentions "dup".
    const result = expectErr(parseRoster(source));
    expect(result.errors.some((e) => e.message.includes("dup"))).toBe(true);
  });

  test("invalid name charset is rejected", () => {
    // Fails if: a name containing a slash and uppercase letters is accepted.
    const result = expectErr(parseRoster(rosterWith({ name: "Not/Valid" })));
    expect(result.errors.some((e) => e.field === "name")).toBe(true);
  });

  test("whitespace-only job is rejected", () => {
    // Fails if: a job of only spaces/newlines is accepted.
    const result = expectErr(parseRoster(rosterWith({ job: "   \n  " })));
    expect(result.errors.some((e) => e.field === "job")).toBe(true);
  });

  test("non-absolute cwd is rejected", () => {
    // Fails if: a relative cwd like "relative/path" is accepted.
    const result = expectErr(parseRoster(rosterWith({ cwd: "relative/path" })));
    expect(result.errors.some((e) => e.field === "cwd")).toBe(true);
  });

  test("mcpServers not an object (a list) is rejected", () => {
    // Fails if: mcpServers given as a list is accepted.
    const result = expectErr(parseRoster(rosterWith({ mcpServers: ["not", "a", "map"] })));
    expect(result.errors.some((e) => e.field === "mcpServers")).toBe(true);
  });

  test("mcpServers server value not an object is rejected", () => {
    // Fails if: a server entry whose value is a bare string is accepted.
    const result = expectErr(parseRoster(rosterWith({ mcpServers: { fs: "not-an-object" } })));
    expect(result.errors.some((e) => e.field === "mcpServers")).toBe(true);
  });

  test("mcpServers server with neither command nor url is rejected", () => {
    // Fails if: a server config with only an unrelated key is accepted.
    const result = expectErr(parseRoster(rosterWith({ mcpServers: { fs: { foo: "bar" } } })));
    expect(result.errors.some((e) => e.field === "mcpServers")).toBe(true);
  });

  test("mcpServers server accepted with url alone (no command)", () => {
    // Fails if: a real http/sse-shaped server config (url only) is rejected.
    const result = expectOk(parseRoster(rosterWith({ mcpServers: { remote: { type: "http", url: "https://example.com/mcp" } } })));
    expect(result.roster.agents[0]?.mcpServers["remote"]).toEqual({ type: "http", url: "https://example.com/mcp" });
  });

  test("mcpServers args present but not an array of strings is rejected", () => {
    // Fails if: args: [1, 2] (numbers, not strings) is accepted.
    const result = expectErr(parseRoster(rosterWith({ mcpServers: { fs: { command: "mcp-fs", args: [1, 2] } } })));
    expect(result.errors.some((e) => e.field === "mcpServers")).toBe(true);
  });

  test("mcpServers env present but not a string map is rejected", () => {
    // Fails if: env: { PORT: 8080 } (a number value) is accepted.
    const result = expectErr(parseRoster(rosterWith({ mcpServers: { fs: { command: "mcp-fs", env: { PORT: 8080 } } } })));
    expect(result.errors.some((e) => e.field === "mcpServers")).toBe(true);
  });

  test("unknown key on an entry is rejected, error names the key", () => {
    // Fails if: an entry with an extra "cwdd" key is silently accepted.
    const result = expectErr(parseRoster(rosterWith({ cwdd: "/typo" })));
    expect(result.errors.some((e) => e.message.includes("cwdd"))).toBe(true);
  });

  test("multiple independent errors in one roster are all reported, not just the first", () => {
    const source = Bun.YAML.stringify({
      agents: [
        { name: "Bad Name", job: "", cwd: "relative", mcpServers: {} },
        { name: "ok-one", job: "fine", cwd: "/abs", mcpServers: {} },
      ],
    });
    // Fails if: fewer than the 3 known-bad fields on the first entry are
    // reported (i.e. the parser stops after the first error).
    const result = expectErr(parseRoster(source));
    const fields = result.errors.map((e) => e.field);
    expect(fields).toContain("name");
    expect(fields).toContain("job");
    expect(fields).toContain("cwd");
  });

  test("unknown top-level key is rejected", () => {
    // Fails if: a stray top-level key alongside "agents" is silently ignored.
    const result = expectErr(parseRoster("agents: []\nextra: true\n"));
    expect(result.errors.some((e) => e.message.includes("extra"))).toBe(true);
  });

  test("shipped example roster parses ok:true", async () => {
    // Fails if: examples/roster.yaml is missing, unreadable, or no longer
    // satisfies parseRoster's rules — i.e. the shipped example has rotted.
    const source = await Bun.file(new URL("../../examples/roster.yaml", import.meta.url)).text();
    expectOk(parseRoster(source));
  });
});
