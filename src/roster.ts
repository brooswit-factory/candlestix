// Pure on purpose: text in, typed result out. No fs, no process, no clock,
// no network, no logging. Bun.YAML.parse is a pure string->value call and is
// safe to use here; everything else in this module must stay just as pure.

export interface McpServerConfig {
  command?: string;
  url?: string;
  args?: string[];
  env?: Record<string, string>;
  [key: string]: unknown;
}

export interface RosterAgent {
  name: string;
  job: string;
  mcpServers: Record<string, McpServerConfig>;
  cwd: string;
}

export interface Roster {
  agents: RosterAgent[];
}

export interface RosterError {
  /** Index of the offending entry in `agents`, when the error is entry-scoped. */
  index?: number;
  /** The entry's `name`, when it is known and usable (i.e. itself valid). */
  name?: string;
  /** The field the error concerns, when the error is field-scoped. */
  field?: string;
  /** Self-contained human-readable message; includes index/name/field context inline. */
  message: string;
}

export type ParseRosterResult = { ok: true; roster: Roster } | { ok: false; errors: RosterError[] };

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const AGENT_FIELDS = new Set(["name", "job", "mcpServers", "cwd"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

function entryLabel(index: number, name: unknown): string {
  return typeof name === "string" && name.length > 0 ? `entry ${index} ("${name}")` : `entry ${index}`;
}

function fieldError(index: number, name: string | undefined, field: string, message: string): RosterError {
  return name === undefined ? { index, field, message } : { index, name, field, message };
}

function validateMcpServers(mcpServers: unknown, index: number, label: string, errors: RosterError[]): void {
  if (!isPlainObject(mcpServers)) {
    errors.push({
      index,
      field: "mcpServers",
      message: `${label}: "mcpServers" must be a plain object mapping server name to server config, got ${describeType(mcpServers)}`,
    });
    return;
  }

  for (const [serverName, serverConfig] of Object.entries(mcpServers)) {
    if (!isPlainObject(serverConfig)) {
      errors.push({
        index,
        field: "mcpServers",
        message: `${label}: mcpServers["${serverName}"] must be a plain object, got ${describeType(serverConfig)}`,
      });
      continue;
    }

    const hasCommand = typeof serverConfig.command === "string" && serverConfig.command.length > 0;
    const hasUrl = typeof serverConfig.url === "string" && serverConfig.url.length > 0;
    if (!hasCommand && !hasUrl) {
      errors.push({
        index,
        field: "mcpServers",
        message: `${label}: mcpServers["${serverName}"] must have a non-empty string "command" or "url"`,
      });
    }

    if ("args" in serverConfig) {
      const args = serverConfig.args;
      const isStringArray = Array.isArray(args) && args.every((a) => typeof a === "string");
      if (!isStringArray) {
        errors.push({
          index,
          field: "mcpServers",
          message: `${label}: mcpServers["${serverName}"].args must be an array of strings when present, got ${describeType(args)}`,
        });
      }
    }

    if ("env" in serverConfig) {
      const env = serverConfig.env;
      const isStringMap = isPlainObject(env) && Object.values(env).every((v) => typeof v === "string");
      if (!isStringMap) {
        errors.push({
          index,
          field: "mcpServers",
          message: `${label}: mcpServers["${serverName}"].env must be an object of strings when present, got ${describeType(env)}`,
        });
      }
    }
  }
}

function validateEntry(entry: unknown, index: number, errors: RosterError[]): RosterAgent | undefined {
  if (!isPlainObject(entry)) {
    errors.push({ index, message: `entry ${index}: must be a mapping, got ${describeType(entry)}` });
    return undefined;
  }

  const rawName = entry["name"];
  const label = entryLabel(index, rawName);

  for (const key of Object.keys(entry)) {
    if (!AGENT_FIELDS.has(key)) {
      errors.push({ index, field: key, message: `${label}: unknown key "${key}"` });
    }
  }

  let name: string | undefined;
  if (typeof rawName !== "string" || rawName.length === 0) {
    errors.push({ index, field: "name", message: `${label}: "name" is required and must be a non-empty string` });
  } else if (!NAME_PATTERN.test(rawName)) {
    errors.push({
      index,
      field: "name",
      message: `${label}: "name" ("${rawName}") must match ${NAME_PATTERN} (lowercase letters, digits, ".", "_", "-", starting with a letter or digit)`,
    });
  } else {
    name = rawName;
  }

  const rawJob = entry["job"];
  let job: string | undefined;
  if (typeof rawJob !== "string" || rawJob.trim().length === 0) {
    errors.push(fieldError(index, name, "job", `${label}: "job" is required and must be a non-empty string`));
  } else {
    job = rawJob;
  }

  const rawCwd = entry["cwd"];
  let cwd: string | undefined;
  if (typeof rawCwd !== "string" || rawCwd.length === 0) {
    errors.push(fieldError(index, name, "cwd", `${label}: "cwd" is required and must be a non-empty string`));
  } else if (!rawCwd.startsWith("/")) {
    errors.push(fieldError(index, name, "cwd", `${label}: "cwd" ("${rawCwd}") must be an absolute path (start with "/")`));
  } else {
    cwd = rawCwd;
  }

  const rawMcpServers = entry["mcpServers"];
  if (rawMcpServers === undefined) {
    errors.push(
      fieldError(index, name, "mcpServers", `${label}: "mcpServers" is required — write "{}" explicitly when an agent has no MCP servers`)
    );
  } else {
    validateMcpServers(rawMcpServers, index, label, errors);
  }

  if (name === undefined || job === undefined || cwd === undefined || !isPlainObject(rawMcpServers)) {
    return undefined;
  }

  // mcpServers may still have per-server errors already recorded above; the
  // shape below is still returned so a valid roster's other entries are not
  // penalised, but callers only get `roster` back on an overall `ok: true`.
  return { name, job, cwd, mcpServers: rawMcpServers as Record<string, McpServerConfig> };
}

export function parseRoster(source: string): ParseRosterResult {
  if (source.trim().length === 0) {
    return { ok: false, errors: [{ message: "roster source is empty or whitespace-only" }] };
  }

  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(source);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, errors: [{ message: `roster is not valid YAML: ${detail}` }] };
  }

  if (!isPlainObject(parsed)) {
    return { ok: false, errors: [{ message: `top level of the roster must be a mapping with an "agents" key, got ${describeType(parsed)}` }] };
  }

  const errors: RosterError[] = [];

  for (const key of Object.keys(parsed)) {
    if (key !== "agents") {
      errors.push({ field: key, message: `unknown top-level key "${key}"` });
    }
  }

  const rawAgents = parsed["agents"];
  if (rawAgents === undefined) {
    errors.push({ field: "agents", message: `top-level "agents" key is required and must be a list` });
    return { ok: false, errors };
  }
  if (!Array.isArray(rawAgents)) {
    errors.push({ field: "agents", message: `top-level "agents" must be a list, got ${describeType(rawAgents)}` });
    return { ok: false, errors };
  }

  const agents: RosterAgent[] = [];
  const nameIndices = new Map<string, number[]>();

  rawAgents.forEach((entry, index) => {
    const agent = validateEntry(entry, index, errors);
    if (agent) {
      agents.push(agent);
      const indices = nameIndices.get(agent.name) ?? [];
      indices.push(index);
      nameIndices.set(agent.name, indices);
    }
  });

  for (const [name, indices] of nameIndices) {
    if (indices.length > 1) {
      errors.push({
        name,
        message: `duplicate agent name "${name}" at entries ${indices.join(", ")}`,
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, roster: { agents } };
}
