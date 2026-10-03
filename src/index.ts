#!/usr/bin/env node
import path from "node:path";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
import { Workspace } from "./workspace.js";

const USAGE = `Usage: cmake-build-model-mcp [options] <build-dir>...

MCP server (stdio) exposing the CMake File API build model of the given build directories.
Read-only: it never runs CMake. Each build directory must already contain a File API reply
(codemodel-v2).

Options:
  --build-dir <dir>   Build directory (repeatable). Positional arguments are build directories too.
  -h, --help          Show this help.
  -v, --version       Show the version.
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "build-dir": { type: "string", multiple: true },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (values.version) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }

  const buildDirs = [...new Set([...(values["build-dir"] ?? []), ...positionals].map((d) => path.resolve(d)))];
  if (!buildDirs.length) {
    process.stderr.write(`error: pass at least one build directory.\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }

  const workspace = new Workspace({ buildDirs });
  try {
    await workspace.ensureLoaded();
  } catch (err) {
    process.stderr.write(`[${SERVER_NAME}] ${(err as Error).message}\n`);
    process.exitCode = 1;
    return;
  }

  const server = createServer(workspace);
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  process.stderr.write(`[${SERVER_NAME}] ${(err as Error).stack ?? String(err)}\n`);
  process.exitCode = 1;
});
