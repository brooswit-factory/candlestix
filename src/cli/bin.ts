#!/usr/bin/env bun
// The ONE impure entry point: wires real process.argv, real stdio, the
// real API client (over the real socket path) and the real `claude attach`
// runner to src/cli/main.ts's pure orchestration. Everything else in the
// CLI is unit-tested without ever touching a real process stream or a real
// `claude` binary; this file is deliberately the only one that is not.

import * as readline from "node:readline/promises";
import { createApiClient } from "./api-client";
import { spawnClaudeAttach } from "./attach-runner";
import { runCli, type CliIO } from "./main";
// The ONE socket-path resolver, imported — never re-derived. Re-exported by
// the contract module from src/paths.ts, which is what the daemon itself
// calls to bind (src/index.ts). Two functions computing this path
// independently is exactly the defect this import exists to make
// impossible; see test/unit/cli/socket-path.test.ts for the identity proof.
import { apiSocketPath } from "../api/contract";

async function promptAndReadLine(promptText: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(promptText);
  } finally {
    rl.close();
  }
}

const io: CliIO = {
  writeStdout: (s) => {
    process.stdout.write(s);
  },
  writeStderr: (s) => {
    process.stderr.write(s);
  },
  stdinIsTTY: process.stdin.isTTY === true,
  stdoutIsTTY: process.stdout.isTTY === true,
  promptAndReadLine,
  spawnAttach: spawnClaudeAttach,
};

const apiClient = createApiClient({ socketPath: apiSocketPath() });

runCli(process.argv.slice(2), { apiClient, io }).then((exitCode) => {
  process.exitCode = exitCode;
});
