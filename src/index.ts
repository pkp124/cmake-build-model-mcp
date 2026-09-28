#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
import { Workspace } from "./workspace.js";

const USAGE = `Usage: cmake-build-model-mcp [options] [root...]

MCP server (stdio) exposing the CMake File API build model of the CMake projects under the given roots.
Read-only: it never runs CMake. Build directories must already contain File API replies (codemodel-v2).

Options:
  --root <dir>        Workspace root to scan (repeatable). Positional arguments are roots too.
                      Also read from CMAKE_MCP_ROOTS (${path.delimiter}-separated). When no root is
                      given, the client's MCP roots are used, falling back to the current directory.
  --build-dir <dir>   Additional build directory outside the roots (repeatable).
  --max-depth <n>     Maximum directory depth to scan below each root (default: 6).
  -h, --help          Show this help.
  -v, --version       Show the version.
`;

function main(): void {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: "string", multiple: true },
      "build-dir": { type: "string", multiple: true },
      "max-depth": { type: "string" },
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

  const envRoots = (process.env.CMAKE_MCP_ROOTS ?? "").split(path.delimiter).filter(Boolean);
  const explicitRoots = [...(values.root ?? []), ...positionals, ...envRoots];

  const workspace = new Workspace({
    roots: explicitRoots.length ? explicitRoots : [process.cwd()],
    maxScanDepth: positiveInt(values["max-depth"], 6, "--max-depth"),
    extraBuildDirs: values["build-dir"],
  });

  const server = createServer(workspace);
  const lowLevel = server.server;

  if (!explicitRoots.length) {
    const fetchRoots = async (): Promise<string[] | undefined> => {
      if (!lowLevel.getClientCapabilities()?.roots) return undefined;
      try {
        const { roots } = await lowLevel.listRoots();
        return roots.filter((r) => r.uri.startsWith("file://")).map((r) => fileURLToPath(r.uri));
      } catch (err) {
        process.stderr.write(`[${SERVER_NAME}] failed to list client roots: ${(err as Error).message}\n`);
        return undefined;
      }
    };
    const syncRoots = () => workspace.setRootsAsync(fetchRoots());
    lowLevel.oninitialized = syncRoots;
    lowLevel.setNotificationHandler(RootsListChangedNotificationSchema, async () => syncRoots());
  }

  void server.connect(new StdioServerTransport());
}

function positiveInt(value: string | undefined, fallback: number, flag: string): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} must be a positive integer.`);
  return n;
}

main();
