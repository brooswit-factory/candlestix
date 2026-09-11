import { describe, expect, test } from "bun:test";
import { parseArgv } from "../../../src/cli/grammar";

describe("parseArgv — create (the bare word)", () => {
  test("zero arguments is create, blank", () => {
    expect(parseArgv([])).toEqual({ ok: true, command: { kind: "create" } });
  });

  test("--name and --job build a create command", () => {
    expect(parseArgv(["--name", "foo", "--job", "watch PRs"])).toEqual({
      ok: true,
      command: { kind: "create", name: "foo", job: "watch PRs" },
    });
  });

  test("the explicit word 'create' is accepted too, with the same flags", () => {
    expect(parseArgv(["create", "--name", "foo"])).toEqual({ ok: true, command: { kind: "create", name: "foo" } });
  });

  test("'create' with an extra positional is a usage error, not a guess", () => {
    const result = parseArgv(["create", "extra"]);
    expect(result.ok).toBe(false);
  });

  test("--yes is not valid on create — negative control that flag-gating actually rejects something", () => {
    const result = parseArgv(["--yes"]);
    expect(result.ok).toBe(false);
  });

  test("--name with no value is a usage error", () => {
    expect(parseArgv(["--name"]).ok).toBe(false);
  });

  test("--job with no value is a usage error", () => {
    expect(parseArgv(["--job"]).ok).toBe(false);
  });
});

describe("parseArgv — list", () => {
  test("bare 'list' hides archived by default", () => {
    expect(parseArgv(["list"])).toEqual({ ok: true, command: { kind: "list", showArchived: false } });
  });

  test("'list --archived' shows archived", () => {
    expect(parseArgv(["list", "--archived"])).toEqual({ ok: true, command: { kind: "list", showArchived: true } });
  });

  test("'list' with an extra positional is a usage error", () => {
    expect(parseArgv(["list", "extra"]).ok).toBe(false);
  });

  test("'list --name x' is a usage error — --name is not valid with list", () => {
    expect(parseArgv(["list", "--name", "x"]).ok).toBe(false);
  });
});

describe("parseArgv — attach (a bare id|name)", () => {
  test("a single positional is attach", () => {
    expect(parseArgv(["my-agent"])).toEqual({ ok: true, command: { kind: "attach", idOrName: "my-agent" } });
  });

  test("a name that RESEMBLES an id is still just an opaque positional to the parser", () => {
    expect(parseArgv(["@01h2xy9k3mnpqrstv0"])).toEqual({
      ok: true,
      command: { kind: "attach", idOrName: "@01h2xy9k3mnpqrstv0" },
    });
  });

  test("attach takes no flags", () => {
    expect(parseArgv(["my-agent", "--yes"]).ok).toBe(false);
  });
});

describe("parseArgv — on/off/archive/unarchive", () => {
  for (const verb of ["on", "off", "archive", "unarchive"] as const) {
    test(`<id|name> ${verb}`, () => {
      expect(parseArgv(["my-agent", verb])).toEqual({ ok: true, command: { kind: verb, idOrName: "my-agent" } });
    });

    test(`<id|name> ${verb} with extra arguments is a usage error`, () => {
      expect(parseArgv(["my-agent", verb, "extra"]).ok).toBe(false);
    });

    test(`<id|name> ${verb} rejects flags`, () => {
      expect(parseArgv(["my-agent", verb, "--yes"]).ok).toBe(false);
    });
  }

  test("an unknown verb is a usage error, not a guess", () => {
    const result = parseArgv(["my-agent", "frobnicate"]);
    expect(result.ok).toBe(false);
  });
});

describe("parseArgv — name / rename", () => {
  test("<id|name> name <new-name>", () => {
    expect(parseArgv(["my-agent", "name", "new-name"])).toEqual({
      ok: true,
      command: { kind: "rename", idOrName: "my-agent", newName: "new-name" },
    });
  });

  test("'rename' is an accepted alias for 'name'", () => {
    expect(parseArgv(["my-agent", "rename", "new-name"])).toEqual({
      ok: true,
      command: { kind: "rename", idOrName: "my-agent", newName: "new-name" },
    });
  });

  test("a missing new name is a usage error", () => {
    expect(parseArgv(["my-agent", "name"]).ok).toBe(false);
  });

  test("extra arguments after the new name are a usage error", () => {
    expect(parseArgv(["my-agent", "name", "new-name", "extra"]).ok).toBe(false);
  });
});

describe("parseArgv — delete", () => {
  test("<id|name> delete, no --yes", () => {
    expect(parseArgv(["my-agent", "delete"])).toEqual({ ok: true, command: { kind: "delete", idOrName: "my-agent", yes: false } });
  });

  test("<id|name> delete --yes", () => {
    expect(parseArgv(["my-agent", "delete", "--yes"])).toEqual({
      ok: true,
      command: { kind: "delete", idOrName: "my-agent", yes: true },
    });
  });

  test("-y is accepted as a short alias for --yes", () => {
    expect(parseArgv(["my-agent", "delete", "-y"])).toEqual({
      ok: true,
      command: { kind: "delete", idOrName: "my-agent", yes: true },
    });
  });

  test("extra positional arguments after delete are a usage error", () => {
    expect(parseArgv(["my-agent", "delete", "extra"]).ok).toBe(false);
  });
});

describe("parseArgv — flag-like or bare-dash tokens where a name is expected (DoD)", () => {
  test("a bare '--' is a usage error, never silently treated as an id-or-name", () => {
    const result = parseArgv(["--"]);
    expect(result.ok).toBe(false);
  });

  test("an unrecognized flag-like token alone is a usage error", () => {
    const result = parseArgv(["-z"]);
    expect(result.ok).toBe(false);
  });

  test("a recognized flag with zero positionals, disallowed for the resolved command, is a usage error (not silently create)", () => {
    // --archived only makes sense for `list`; with no positional at all this
    // resolves to `create`, which does not accept it.
    const result = parseArgv(["--archived"]);
    expect(result.ok).toBe(false);
  });
});

describe("parseArgv — never carries a second reserved-name list", () => {
  test("this module imports nothing at all — the strongest available proof it cannot consult a second reserved-word list or a name-syntax validator", async () => {
    const source = await Bun.file(new URL("../../../src/cli/grammar.ts", import.meta.url)).text();
    const importLines = source.split("\n").filter((line) => /^\s*import\b/.test(line));
    expect(importLines).toEqual([]);
  });

  test("a reserved word is accepted by the PARSER as a plain id-or-name in the top-level position — the daemon refuses it, not the CLI", () => {
    // "on", "archive" and "delete" all collide with this grammar's own verb
    // words; alone, in the id-or-name position, each is simply an opaque
    // string to the parser (attach) — it never consults a name-reservation
    // list to reject them earlier.
    for (const word of ["on", "archive", "delete"]) {
      expect(parseArgv([word])).toEqual({ ok: true, command: { kind: "attach", idOrName: word } });
    }
  });

  test("a reserved word also passes through untouched in the SECOND position, as the id-or-name half of a two-word form", () => {
    // e.g. `candlestix delete on` reads as "run the delete verb against an
    // agent literally called on" to this parser — never rejected here.
    expect(parseArgv(["delete", "on"])).toEqual({ ok: true, command: { kind: "on", idOrName: "delete" } });
  });
});
