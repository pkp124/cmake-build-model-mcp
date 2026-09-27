import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { tail, type RunResult } from "./cmake/runner.js";
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
    "Build directory (absolute, or relative to a workspace root). A source directory with a single build " +
      "directory is also accepted. May be omitted when the workspace has exactly one build directory.",
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
      if (err instanceof WorkspaceError || err instanceof ModelError) return errorResult(err.message);
      return errorResult(`Unexpected error: ${(err as Error).stack ?? String(err)}`);
    }
  };
}

function runSummary(result: RunResult, maxLines: number) {
  return {
    command: result.command,
    exitCode: result.exitCode,
    success: result.exitCode === 0,
    timedOut: result.timedOut || undefined,
    durationMs: result.durationMs,
    output: tail(result.output, maxLines),
  };
}

export function createServer(workspace: Workspace): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Query the build model (targets, sources, compile flags, include paths, defines, dependencies, cache " +
        "variables, toolchains) of CMake projects via the CMake File API. Start with `list_projects` to see the " +
        "source projects and build directories in the workspace; most tools take a `buildDir` argument. Use " +
        "`find_file_targets` to learn how a specific source or header file is compiled.",
    },
  );

  async function codemodelFor(buildDirInput: string | undefined, configuration: string | undefined) {
    const buildDir = await workspace.resolveBuildDir(buildDirInput);
    const reply = await workspace.getReply(buildDir, "codemodel");
    const codemodel = (await reply.object("codemodel"))!;
    const config = selectConfiguration(codemodel, configuration, workspace.getBuildDirInfo(buildDir)?.buildType);
    return { buildDir, reply, config };
  }

  server.registerTool(
    "list_projects",
    {
      title: "List CMake projects and build directories",
      description:
        "Lists top-level CMake source projects and build directories found under the workspace roots, including " +
        "which source directory each build directory belongs to, its generator/build type and whether a File API " +
        "reply is available and up to date.",
      inputSchema: {
        rescan: z.boolean().optional().describe("Re-scan the workspace roots for new projects and build directories."),
      },
      annotations: READ_ONLY,
    },
    handler(async ({ rescan }) => {
      if (rescan) await workspace.rescan();
      const { projects, buildDirs } = await workspace.listProjects();
      const withStatus = await Promise.all(
        buildDirs.map(async (b) => ({ ...b, fileApi: await workspace.replyStatus(b.buildDir) })),
      );
      return json({
        roots: workspace.getRoots(),
        projects: projects.map((p) => ({
          ...p,
          buildDirs: buildDirs.filter((b) => b.sourceDir === p.sourceDir).map((b) => b.buildDir),
        })),
        buildDirs: withStatus,
      });
    }),
  );

  server.registerTool(
    "register_build_dir",
    {
      title: "Register a build directory",
      description:
        "Adds an existing CMake build directory (one containing CMakeCache.txt) that lies outside the workspace " +
        "roots, e.g. /tmp/build-foo, so the other tools can query it.",
      inputSchema: { buildDir: z.string().describe("Path to the build directory.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handler(async ({ buildDir }) => json(await workspace.registerBuildDir(buildDir))),
  );

  server.registerTool(
    "list_presets",
    {
      title: "List CMake presets",
      description:
        "Lists the configure and build presets from CMakePresets.json / CMakeUserPresets.json of a source " +
        "directory, with resolved binary directories.",
      inputSchema: { sourceDir: z.string().describe("Source directory containing the presets file.") },
      annotations: READ_ONLY,
    },
    handler(async ({ sourceDir }) => json(await workspace.presets(sourceDir))),
  );

  server.registerTool(
    "configure",
    {
      title: "Configure a CMake build directory",
      description:
        "Runs the CMake configure step so a fresh File API reply is generated. Three modes: (1) `sourceDir` + " +
        "`preset` configures with a configure preset; (2) `sourceDir` (+ optional `buildDir`, default " +
        "<sourceDir>/build) creates or updates a build directory; (3) only `buildDir` re-runs CMake on an " +
        "existing build directory with its cached settings.",
      inputSchema: {
        sourceDir: z.string().optional().describe("Source directory containing the top-level CMakeLists.txt."),
        buildDir: z.string().optional().describe("Build directory."),
        preset: z.string().optional().describe("Configure preset name (requires sourceDir)."),
        generator: z.string().optional().describe("CMake generator, e.g. 'Ninja' or 'Unix Makefiles' (new build dirs only)."),
        buildType: z.string().optional().describe("Sets CMAKE_BUILD_TYPE."),
        cacheVariables: z.record(z.string(), z.string()).optional().describe("Cache variables passed as -D<name>=<value>."),
        extraArgs: z.array(z.string()).optional().describe("Additional raw arguments for cmake."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handler(async (args) => {
      const { buildDir, result } = await workspace.configure(args);
      return {
        ...json({ buildDir, ...runSummary(result, 80), fileApi: await workspace.replyStatus(buildDir) }),
        isError: result.exitCode !== 0,
      };
    }),
  );

  server.registerTool(
    "build",
    {
      title: "Build targets",
      description: "Runs `cmake --build` for a build directory, optionally limited to specific targets.",
      inputSchema: {
        buildDir: buildDirArg,
        targets: z.array(z.string()).optional().describe("Targets to build; defaults to the 'all' target."),
        configuration: configurationArg,
        parallel: z.number().int().positive().optional().describe("Maximum number of parallel jobs."),
        clean: z.boolean().optional().describe("Clean before building (--clean-first)."),
        timeoutSeconds: z.number().positive().optional().describe("Timeout for the build."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    handler(async ({ timeoutSeconds, ...args }) => {
      const { buildDir, result } = await workspace.build({
        ...args,
        timeoutMs: timeoutSeconds ? timeoutSeconds * 1000 : undefined,
      });
      return { ...json({ buildDir, ...runSummary(result, 120) }), isError: result.exitCode !== 0 };
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
        "returns the effective language, standard, flags, defines, include directories and an approximate " +
        "compiler command line. For headers not listed as sources, returns targets whose include directories " +
        "contain the file. Searches all known build directories unless `buildDir` is given.",
      inputSchema: {
        file: z.string().describe("Path to the file (absolute or relative to a workspace root)."),
        buildDir: buildDirArg,
        configuration: configurationArg,
        includeBacktraces: z.boolean().default(false),
      },
      annotations: READ_ONLY,
    },
    handler(async ({ file, buildDir, configuration, includeBacktraces }) => {
      await workspace.ensureScanned();
      const absFile = path.isAbsolute(file) ? path.normalize(file) : workspace.resolvePath(file);
      let candidates: string[];
      if (buildDir) {
        candidates = [await workspace.resolveBuildDir(buildDir)];
      } else {
        const all = await workspace.allBuildDirs();
        const owning = all.filter((b) => b.sourceDir && isWithin(absFile, b.sourceDir));
        candidates = (owning.length ? owning : all).map((b) => b.buildDir);
      }
      if (!candidates.length) return errorResult("No build directories known; use `configure` first.");

      const matches: FileMatch[] = [];
      const errors: { buildDir: string; error: string }[] = [];
      for (const dir of candidates) {
        try {
          const reply = await workspace.getReply(dir, "codemodel");
          matches.push(...(await findFile(reply, absFile, { configuration, includeBacktraces })));
        } catch (err) {
          errors.push({ buildDir: dir, error: (err as Error).message });
        }
      }
      return json({
        file: absFile,
        searchedBuildDirs: candidates,
        matchCount: matches.length,
        matches,
        errors: errors.length ? errors : undefined,
      });
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

  return server;
}
