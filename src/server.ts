import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { COMPILE_COMMANDS_HINT, entryMatches } from "./compileCommands.js";
import {
  dependencyGraph,
  findFile,
  globOrRegex,
  isWithin,
  listTargets,
  ModelError,
  selectConfiguration,
  summarize,
  targetDetails,
  type FileMatch,
} from "./model.js";
import { CtestError } from "./ctest/error.js";
import { registerCTestTools } from "./ctest/tools.js";
import { Workspace, WorkspaceError } from "./workspace.js";

export const SERVER_NAME = "cmake-build-model";
export const SERVER_VERSION = "0.1.0";

const TARGET_TYPES = [
  "EXECUTABLE",
  "STATIC_LIBRARY",
  "SHARED_LIBRARY",
  "MODULE_LIBRARY",
  "OBJECT_LIBRARY",
  "INTERFACE_LIBRARY",
  "UTILITY",
] as const;

const buildDirArg = z
  .string()
  .optional()
  .describe(
    "Build directory given when the server was started. An absolute path, or a unique suffix such as " +
      "`build-debug`. Omit when the server was started with exactly one build directory.",
  );
const configurationArg = z
  .string()
  .optional()
  .describe("Build configuration (e.g. Debug, Release) for multi-config generators. Defaults to the first one.");

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Converts expected user errors into tool errors instead of protocol errors. */
function handler<A>(fn: (args: A) => Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return await fn(args);
    } catch (err) {
      if (err instanceof WorkspaceError || err instanceof ModelError || err instanceof CtestError) return errorResult(err.message);
      return errorResult(`Unexpected error: ${(err as Error).stack ?? String(err)}`);
    }
  };
}

export function createServer(workspace: Workspace): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Query the build model (targets, sources, compile flags, include paths, defines, dependencies, cache " +
        "variables, toolchains) of CMake projects via the CMake File API, plus the exact compile commands from " +
        "compile_commands.json. It also reads CTestTestfile.cmake (test names, labels, fixtures, dependencies) " +
        "and CTest Test.xml results. It never runs test executables. preview_test_run is a dry run; its ctest " +
        "engine runs `ctest --show-only` and does not execute tests. Start with `list_build_dirs`. Pass " +
        "`buildDir` when more than one build directory was given. Use `find_file_targets` to learn how a " +
        "specific source or header file is compiled, and `preview_test_run` to see which tests a -R/-E/-L/-LE " +
        "selection would run.",
    },
  );

  async function codemodelFor(buildDirInput: string | undefined, configuration: string | undefined) {
    const buildDir = await workspace.resolveBuildDir(buildDirInput);
    const reply = await workspace.getReply(buildDir, "codemodel");
    const codemodel = (await reply.object("codemodel"))!;
    const config = selectConfiguration(codemodel, configuration, workspace.getBuildDirInfo(buildDir)?.buildType);
    return { buildDir, reply, config };
  }

  /** Build directories whose source tree contains `file`, or all of them if none does. */
  async function candidateBuildDirs(file: string, buildDir: string | undefined): Promise<string[]> {
    if (buildDir) return [await workspace.resolveBuildDir(buildDir)];
    const all = await workspace.listBuildDirs();
    const owning = all.filter((b) => b.sourceDir && isWithin(file, b.sourceDir));
    return (owning.length ? owning : all).map((b) => b.buildDir);
  }

  server.registerTool(
    "list_build_dirs",
    {
      title: "List build directories",
      description:
        "Lists the build directories given when the server was started, including each source directory, " +
        "generator, build type, and whether a File API reply is available and up to date.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    handler(async () => {
      const buildDirs = await workspace.listBuildDirs();
      const withStatus = await Promise.all(
        buildDirs.map(async (b) => ({
          ...b,
          fileApi: await workspace.replyStatus(b.buildDir),
          ctest: await workspace.ctestStatus(b.buildDir),
        })),
      );
      return json({ buildDirs: withStatus });
    }),
  );

  server.registerTool(
    "get_project_summary",
    {
      title: "Summarize a build directory's model",
      description:
        "High-level overview of a configured build directory: CMake version, generator, configurations, the " +
        "project() hierarchy and target names grouped by type.",
      inputSchema: { buildDir: buildDirArg, configuration: configurationArg },
      annotations: READ_ONLY,
    },
    handler(async ({ buildDir, configuration }) => {
      const { reply, config } = await codemodelFor(buildDir, configuration);
      return json(await summarize(reply, config));
    }),
  );

  server.registerTool(
    "list_targets",
    {
      title: "List targets",
      description: "Lists build targets with type, project, defining directory, artifacts and languages.",
      inputSchema: {
        buildDir: buildDirArg,
        configuration: configurationArg,
        type: z.array(z.enum(TARGET_TYPES)).optional().describe("Only include these target types."),
        name: z
          .string()
          .optional()
          .describe("Name filter: substring, glob (`*`, `?`) or regex wrapped in slashes, e.g. `/^test_/`."),
        project: z.string().optional().describe("Only targets belonging to this project() name."),
        directory: z.string().optional().describe("Only targets defined in this source directory (or below)."),
      },
      annotations: READ_ONLY,
    },
    handler(async ({ buildDir, configuration, ...filter }) => {
      const { reply, config, buildDir: dir } = await codemodelFor(buildDir, configuration);
      const targets = await listTargets(reply, config, filter);
      return json({ buildDir: dir, configuration: config.name, count: targets.length, targets });
    }),
  );

  server.registerTool(
    "get_target",
    {
      title: "Get target details",
      description:
        "Full details of one target: artifacts, where it is defined, dependencies, link/archive command " +
        "fragments, install destinations, and per compile group the language standard, flags, defines and " +
        "include directories, plus its source files.",
      inputSchema: {
        buildDir: buildDirArg,
        configuration: configurationArg,
        target: z.string().describe("Target name or File API target id."),
        includeSources: z.boolean().default(true).describe("Include the list of source files."),
        maxSources: z.number().int().positive().default(200).describe("Maximum number of sources to list."),
        includeBacktraces: z
          .boolean()
          .default(false)
          .describe("Include CMake backtraces (file:line of the command) for sources, defines, includes, etc."),
      },
      annotations: READ_ONLY,
    },
    handler(async ({ buildDir, configuration, target, ...opts }) => {
      const { reply, config, buildDir: dir } = await codemodelFor(buildDir, configuration);
      return json({ buildDir: dir, configuration: config.name, ...(await targetDetails(reply, config, target, opts)) });
    }),
  );

  server.registerTool(
    "get_target_dependencies",
    {
      title: "Get target dependency graph",
      description:
        "Returns the targets a target depends on (`dependencies`) or the targets depending on it (`dependents`), " +
        "directly or transitively, including an adjacency list for the transitive graph.",
      inputSchema: {
        buildDir: buildDirArg,
        configuration: configurationArg,
        target: z.string().describe("Target name or id."),
        direction: z.enum(["dependencies", "dependents"]).default("dependencies"),
        transitive: z.boolean().default(true),
      },
      annotations: READ_ONLY,
    },
    handler(async ({ buildDir, configuration, target, direction, transitive }) => {
      const { reply, config, buildDir: dir } = await codemodelFor(buildDir, configuration);
      return json({
        buildDir: dir,
        configuration: config.name,
        ...(await dependencyGraph(reply, config, target, { direction, transitive })),
      });
    }),
  );

  server.registerTool(
    "find_file_targets",
    {
      title: "Find how a file is built",
      description:
        "Finds which targets (in which build directories and configurations) compile a given source file, and " +
        "returns the effective language, standard, flags, defines and include directories from the File API " +
        "together with the exact compiler command(s) from the build directory's compile_commands.json. For " +
        "headers not listed as sources, returns targets whose include directories contain the file. Searches " +
        "every build directory given at startup unless `buildDir` is given.",
      inputSchema: {
        file: z
          .string()
          .describe(
            "Path to the file. Absolute, relative to the working directory, or relative to a build's source " +
              "directory when that match is unique.",
          ),
        buildDir: buildDirArg,
        configuration: configurationArg,
        includeBacktraces: z.boolean().default(false),
      },
      annotations: READ_ONLY,
    },
    handler(async ({ file, buildDir, configuration, includeBacktraces }) => {
      const absFile = await workspace.resolveFile(file);
      const candidates = await candidateBuildDirs(absFile, buildDir);

      const matches: FileMatch[] = [];
      const errors: { buildDir: string; error: string }[] = [];
      const withoutCompileCommands: string[] = [];
      for (const dir of candidates) {
        try {
          const reply = await workspace.getReply(dir, "codemodel");
          const compileCommands = await workspace.compileCommands(dir);
          if (!compileCommands) withoutCompileCommands.push(dir);
          matches.push(...(await findFile(reply, absFile, { configuration, includeBacktraces, compileCommands })));
        } catch (err) {
          errors.push({ buildDir: dir, error: (err as Error).message });
        }
      }
      return json({
        file: absFile,
        searchedBuildDirs: candidates,
        matchCount: matches.length,
        matches,
        missingCompileCommands: withoutCompileCommands.length
          ? { buildDirs: withoutCompileCommands, hint: COMPILE_COMMANDS_HINT }
          : undefined,
        errors: errors.length ? errors : undefined,
      });
    }),
  );

  server.registerTool(
    "get_compile_commands",
    {
      title: "Get compile commands",
      description:
        "Reads the exact compiler invocations from compile_commands.json in a build directory, filtered by file, " +
        "path pattern, target and/or configuration. When `file` is given without `buildDir`, every given build " +
        "directory whose source tree contains the file is searched. Each entry has the working directory, " +
        "the argument list, the original command string (when the database uses `command`) and the output file.",
      inputSchema: {
        buildDir: buildDirArg,
        file: z
          .string()
          .optional()
          .describe(
            "Exact source file path. Absolute, relative to the working directory, or relative to a build's " +
              "source directory when that match is unique.",
          ),
        filter: z.string().optional().describe("Source path filter: substring, glob or /regex/."),
        target: z.string().optional().describe("Only commands compiling objects of this target."),
        configuration: z
          .string()
          .optional()
          .describe("Only commands of this configuration (multi-config generators; ignored otherwise)."),
        limit: z.number().int().positive().default(50).describe("Maximum number of entries per build directory."),
      },
      annotations: READ_ONLY,
    },
    handler(async ({ buildDir, file, filter, target, configuration, limit }) => {
      const absFile = file ? await workspace.resolveFile(file) : undefined;
      const candidates =
        absFile && !buildDir ? await candidateBuildDirs(absFile, undefined) : [await workspace.resolveBuildDir(buildDir)];
      const re = filter ? globOrRegex(filter) : undefined;

      const results = [];
      for (const dir of candidates) {
        const db = await workspace.compileCommands(dir);
        if (!db) {
          results.push({ buildDir: dir, compileCommands: null, hint: COMPILE_COMMANDS_HINT });
          continue;
        }
        const config = configuration && (await workspace.isMultiConfig(dir)) ? configuration : undefined;
        const entries = (absFile ? db.forFile(absFile) : db.entries)
          .filter((e) => !re || re.test(e.file))
          .filter((e) => entryMatches(e, target, config));
        if (absFile && !buildDir && !entries.length) continue;
        results.push({
          buildDir: dir,
          compileCommands: db.file,
          totalEntries: db.entries.length,
          matchCount: entries.length,
          truncated: entries.length > limit || undefined,
          entries: entries.slice(0, limit),
        });
      }
      if (absFile && !buildDir && !results.length) {
        return errorResult(`No compile_commands.json entry for ${absFile} in: ${candidates.join(", ")}`);
      }
      return json(results.length === 1 && !absFile ? results[0] : { results });
    }),
  );

  server.registerTool(
    "get_cache_variables",
    {
      title: "Get CMake cache variables",
      description:
        "Returns CMake cache entries (name, type, value, help string), optionally filtered by name. Advanced " +
        "entries are hidden unless `includeAdvanced` is set or a `filter` is given.",
      inputSchema: {
        buildDir: buildDirArg,
        filter: z.string().optional().describe("Name filter: substring, glob or /regex/."),
        includeAdvanced: z.boolean().default(false).describe("Include entries marked as advanced."),
        includeInternal: z.boolean().default(false).describe("Include INTERNAL and STATIC entries."),
      },
      annotations: READ_ONLY,
    },
    handler(async ({ buildDir, filter, includeAdvanced, includeInternal }) => {
      const dir = await workspace.resolveBuildDir(buildDir);
      const cache = (await (await workspace.getReply(dir, "cache")).object("cache"))!;
      const re = filter ? globOrRegex(filter) : undefined;
      const entries = cache.entries
        .filter((e) => !re || re.test(e.name))
        .filter((e) => includeInternal || (e.type !== "INTERNAL" && e.type !== "STATIC"))
        .map((e) => {
          const prop = (name: string) => e.properties.find((p) => p.name === name)?.value;
          return {
            name: e.name,
            type: e.type,
            value: e.value,
            advanced: prop("ADVANCED") === "1" || undefined,
            help: prop("HELPSTRING") || undefined,
            strings: prop("STRINGS")?.split(";"),
          };
        })
        .filter((e) => includeAdvanced || !e.advanced || filter !== undefined);
      return json({ buildDir: dir, count: entries.length, entries });
    }),
  );

  server.registerTool(
    "get_toolchains",
    {
      title: "Get toolchains",
      description:
        "Returns the compilers used per language (path, id, version, target) including implicit include and " +
        "link directories.",
      inputSchema: { buildDir: buildDirArg },
      annotations: READ_ONLY,
    },
    handler(async ({ buildDir }) => {
      const dir = await workspace.resolveBuildDir(buildDir);
      const toolchains = (await (await workspace.getReply(dir, "toolchains")).object("toolchains"))!;
      return json({ buildDir: dir, toolchains: toolchains.toolchains });
    }),
  );

  server.registerTool(
    "get_cmake_inputs",
    {
      title: "Get CMake input files",
      description:
        "Lists the files CMake read during configuration (CMakeLists.txt, included .cmake modules, " +
        "configure_file inputs, etc.) and glob-dependent file lists.",
      inputSchema: {
        buildDir: buildDirArg,
        includeCMakeModules: z.boolean().default(false).describe("Include modules shipped with CMake itself."),
        includeExternal: z.boolean().default(true).describe("Include files outside the source and build trees."),
      },
      annotations: READ_ONLY,
    },
    handler(async ({ buildDir, includeCMakeModules, includeExternal }) => {
      const dir = await workspace.resolveBuildDir(buildDir);
      const reply = await workspace.getReply(dir, "cmakeFiles");
      const files = (await reply.object("cmakeFiles"))!;
      const inputs = files.inputs
        .filter((i) => includeCMakeModules || !i.isCMake)
        .filter((i) => includeExternal || !i.isExternal)
        .map((i) => ({
          path: path.resolve(files.paths.source, i.path),
          isGenerated: i.isGenerated || undefined,
          isExternal: i.isExternal || undefined,
          isCMake: i.isCMake || undefined,
        }));
      return json({
        buildDir: dir,
        count: inputs.length,
        inputs,
        globsDependent: files.globsDependent,
        modifiedSinceConfigure: await workspace.modifiedInputs(reply),
      });
    }),
  );

  registerCTestTools(server, workspace);
  return server;
}
