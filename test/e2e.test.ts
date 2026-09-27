import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.resolve(here, "..", "dist", "index.js");
const hasNinja = spawnSync("ninja", ["--version"]).status === 0;

type Json = any;

let tmp: string;
let ws: string;
/** Build dir outside the workspace roots with a File API reply but no compile_commands.json. */
let outsideNoCompileDb: string;
/** Build dir outside the roots configured without any File API query. */
let outsideNoReply: string;
/** Ninja Multi-Config build dir outside the roots. */
let outsideMultiConfig: string;
let client: Client;

async function writeQueries(buildDir: string): Promise<void> {
  const queryDir = path.join(buildDir, ".cmake", "api", "v1", "query");
  await mkdir(queryDir, { recursive: true });
  for (const q of ["codemodel-v2", "cache-v2", "cmakeFiles-v1", "toolchains-v1"]) {
    await writeFile(path.join(queryDir, q), "");
  }
}

async function cmake(args: string[], opts: { buildDir: string; cwd?: string; query?: boolean }): Promise<void> {
  if (opts.query !== false) await writeQueries(opts.buildDir);
  execFileSync("cmake", args, { cwd: opts.cwd, stdio: "ignore" });
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<{ data: Json; isError: boolean; text: string }> {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text: string }[];
    isError?: boolean;
  };
  const text = result.content.map((c) => c.text).join("\n");
  let data: Json;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  return { data, isError: Boolean(result.isError), text };
}

async function ok(name: string, args: Record<string, unknown> = {}): Promise<Json> {
  const r = await call(name, args);
  if (r.isError) throw new Error(`${name} failed: ${r.text}`);
  return r.data;
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true });
  return entries.map((e) => path.join(dir, e.toString())).sort();
}

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "cmake-mcp-e2e-"));
  ws = path.join(tmp, "ws");
  outsideNoCompileDb = path.join(tmp, "outside-no-compile-db");
  outsideNoReply = path.join(tmp, "outside-no-reply");
  outsideMultiConfig = path.join(tmp, "outside-multi-config");
  await cp(path.join(here, "fixtures", "workspace"), ws, { recursive: true });

  const app = path.join(ws, "app");
  const mathlib = path.join(ws, "mathlib");
  const exportDb = "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON";
  const appDebug = path.join(app, "build-debug");
  await cmake(["-S", app, "-B", appDebug, "-DCMAKE_BUILD_TYPE=Debug", exportDb], { buildDir: appDebug });
  await cmake(["--preset", "release", exportDb], { buildDir: path.join(app, "out", "build", "release"), cwd: app });
  const mathBuild = path.join(mathlib, "build");
  await cmake(["-S", mathlib, "-B", mathBuild, exportDb], { buildDir: mathBuild });
  await cmake(["-S", mathlib, "-B", outsideNoCompileDb], { buildDir: outsideNoCompileDb });
  await cmake(["-S", mathlib, "-B", outsideNoReply], { buildDir: outsideNoReply, query: false });
  if (hasNinja) {
    await cmake(["-S", mathlib, "-B", outsideMultiConfig, "-G", "Ninja Multi-Config", exportDb], {
      buildDir: outsideMultiConfig,
    });
  }

  client = new Client({ name: "e2e", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [serverEntry, "--root", ws], stderr: "inherit" }),
  );
}, 120_000);

afterAll(async () => {
  await client?.close();
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe("cmake-build-model MCP server", () => {
  it("advertises only read-only tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "find_file_targets",
        "get_cache_variables",
        "get_cmake_inputs",
        "get_compile_commands",
        "get_project_summary",
        "get_target",
        "get_target_dependencies",
        "get_toolchains",
        "list_presets",
        "list_projects",
        "list_targets",
        "register_build_dir",
      ].sort(),
    );
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  });

  it("discovers projects and build directories of multiple projects", async () => {
    const data = await ok("list_projects");
    expect(data.projects.map((p: Json) => [p.name, p.sourceDir])).toEqual([
      ["App", path.join(ws, "app")],
      ["MathLib", path.join(ws, "mathlib")],
    ]);
    expect(data.buildDirs.map((b: Json) => b.buildDir)).toEqual([
      path.join(ws, "app", "build-debug"),
      path.join(ws, "app", "out", "build", "release"),
      path.join(ws, "mathlib", "build"),
    ]);
    expect(data.projects[0].buildDirs).toHaveLength(2);
    for (const b of data.buildDirs) {
      expect(b.fileApi).toMatchObject({ hasCodemodel: true, stale: false });
      expect(b.fileApi.compileCommands).toBe(path.join(b.buildDir, "compile_commands.json"));
    }
  });

  it("lists presets with resolved binary directories", async () => {
    const data = await ok("list_presets", { sourceDir: "app" });
    expect(data.configurePresets).toEqual([
      expect.objectContaining({
        name: "release",
        generator: "Unix Makefiles",
        binaryDir: path.join(ws, "app", "out", "build", "release"),
        cacheVariables: { APP_FROM_PRESET: "ON", CMAKE_BUILD_TYPE: "Release" },
      }),
    ]);
  });

  it("requires disambiguation when several build directories exist", async () => {
    const noArg = await call("list_targets");
    expect(noArg.isError).toBe(true);
    expect(noArg.text).toMatch(/Multiple build directories/);

    const bySource = await call("list_targets", { buildDir: "app" });
    expect(bySource.isError).toBe(true);
    expect(bySource.text).toMatch(/several build directories/);

    const math = await ok("list_targets", { buildDir: "mathlib" });
    expect(math.targets.map((t: Json) => t.name).sort()).toEqual(["calc", "mathc"]);
  });

  it("summarizes a build directory", async () => {
    const data = await ok("get_project_summary", { buildDir: "app/build-debug" });
    expect(data.sourceDir).toBe(path.join(ws, "app"));
    expect(data.configurations).toEqual(["Debug"]);
    expect(data.projects[0].name).toBe("App");
    expect(data.targetsByType).toMatchObject({
      STATIC_LIBRARY: ["core"],
      SHARED_LIBRARY: ["plugin"],
      EXECUTABLE: ["app_cli"],
      UTILITY: ["docs"],
    });
  });

  it("lists targets with filters", async () => {
    const libs = await ok("list_targets", {
      buildDir: "app/build-debug",
      type: ["STATIC_LIBRARY", "SHARED_LIBRARY", "INTERFACE_LIBRARY"],
    });
    expect(libs.targets.map((t: Json) => t.name).sort()).toEqual(["core", "headers_only", "plugin"]);

    const inTools = await ok("list_targets", { buildDir: "app/build-debug", directory: "tools" });
    expect(inTools.targets.map((t: Json) => t.name)).toEqual(["app_cli"]);

    const glob = await ok("list_targets", { buildDir: "app/build-debug", name: "app_*" });
    expect(glob.targets[0].artifacts).toEqual([path.join(ws, "app", "build-debug", "tools", "app_cli")]);
  });

  it("returns detailed target information", async () => {
    const core = await ok("get_target", { buildDir: "app/build-debug", target: "core", includeBacktraces: true });
    expect(core.type).toBe("STATIC_LIBRARY");
    expect(core.definedAt).toBe(`${path.join(ws, "app", "CMakeLists.txt")}:4 (add_library)`);
    expect(core.sources.map((s: Json) => s.path)).toEqual([path.join(ws, "app", "src", "core.cpp")]);
    const group = core.compileGroups[0];
    expect(group.language).toBe("CXX");
    expect(group.languageStandard).toBe("20");
    expect(group.defines.map((d: Json) => d.define)).toEqual(expect.arrayContaining(["CORE_VERSION=3", "CORE_INTERNAL"]));
    expect(group.includes.map((i: Json) => i.path)).toContain(path.join(ws, "app", "include"));
    expect(group.includes[0].backtrace[0]).toMatch(/CMakeLists\.txt:5 \(target_include_directories\)/);
    expect(core.install.destinations.map((d: Json) => d.path)).toEqual(["bin"]);

    const cli = await ok("get_target", { buildDir: "app/build-debug", target: "app_cli" });
    expect(cli.compileGroups[0].compileFlags.join(" ")).toMatch(/-Wall/);
    expect(cli.link.language).toBe("CXX");
    expect(cli.dependencies.map((d: Json) => d.name)).toEqual(["core"]);

    const missing = await call("get_target", { buildDir: "app/build-debug", target: "cor" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/Did you mean: core/);
  });

  it("computes dependency graphs in both directions", async () => {
    const deps = await ok("get_target_dependencies", { buildDir: "app/build-debug", target: "plugin" });
    expect(deps.dependencies.map((d: Json) => d.name).sort()).toEqual(["core", "headers_only"]);

    const dependents = await ok("get_target_dependencies", {
      buildDir: "app/build-debug",
      target: "core",
      direction: "dependents",
    });
    expect(dependents.dependents.map((d: Json) => d.name).sort()).toEqual(["app_cli", "plugin"]);
  });

  it("finds the targets that compile a file with the real compile commands", async () => {
    const data = await ok("find_file_targets", { file: "app/src/core.cpp" });
    expect(data.searchedBuildDirs).toHaveLength(2);
    expect(data.missingCompileCommands).toBeUndefined();
    expect(data.matches.map((m: Json) => [path.relative(ws, m.buildDir), m.configuration, m.target])).toEqual([
      ["app/build-debug", "Debug", "core"],
      ["app/out/build/release", "Release", "core"],
    ]);
    const [debug, release] = data.matches;
    expect(debug.compileCommands).toHaveLength(1);
    const entry = debug.compileCommands[0];
    expect(entry.file).toBe(path.join(ws, "app", "src", "core.cpp"));
    expect(entry.directory).toBe(path.join(ws, "app", "build-debug"));
    expect(entry.output).toMatch(/CMakeFiles\/core\.dir\/src\/core\.cpp\.o$/);
    expect(entry.command).toContain("-DCORE_VERSION=3");
    expect(entry.arguments).toEqual(
      expect.arrayContaining(["-DCORE_VERSION=3", "-DCORE_INTERNAL", `-I${path.join(ws, "app", "include")}`, "-g", "-c"]),
    );
    expect(entry.arguments.at(-1)).toBe(path.join(ws, "app", "src", "core.cpp"));
    expect(release.compileCommands[0].arguments).toContain("-O3");

    const header = await ok("find_file_targets", { file: path.join(ws, "mathlib", "src", "mathc.h") });
    expect(header.matches.every((m: Json) => m.matchedBy === "include-directory" && !m.compileCommands)).toBe(true);
    expect(header.matches.map((m: Json) => m.target).sort()).toEqual(["calc", "mathc"]);
  });

  it("queries compile_commands.json directly", async () => {
    const all = await ok("get_compile_commands", { buildDir: "app/build-debug" });
    expect(all.compileCommands).toBe(path.join(ws, "app", "build-debug", "compile_commands.json"));
    expect(all.totalEntries).toBe(3);

    const byTarget = await ok("get_compile_commands", { buildDir: "app/build-debug", target: "plugin" });
    expect(byTarget.entries.map((e: Json) => path.basename(e.file))).toEqual(["plugin.cpp"]);

    const byFilter = await ok("get_compile_commands", { buildDir: "app/build-debug", filter: "*/tools/*", limit: 5 });
    expect(byFilter.entries.map((e: Json) => path.basename(e.file))).toEqual(["main.cpp"]);

    const acrossBuildDirs = await ok("get_compile_commands", { file: "app/tools/main.cpp" });
    expect(acrossBuildDirs.results.map((r: Json) => r.buildDir)).toEqual([
      path.join(ws, "app", "build-debug"),
      path.join(ws, "app", "out", "build", "release"),
    ]);
    expect(acrossBuildDirs.results.every((r: Json) => r.entries[0].arguments.includes("-Wall"))).toBe(true);
  });

  it("returns cache variables, toolchains and cmake inputs", async () => {
    const cache = await ok("get_cache_variables", { buildDir: "app/out/build/release", filter: "APP_*" });
    expect(cache.entries).toEqual([expect.objectContaining({ name: "APP_FROM_PRESET", value: "ON" })]);

    const tc = await ok("get_toolchains", { buildDir: "app/build-debug" });
    expect(tc.toolchains.map((t: Json) => t.language)).toContain("CXX");

    const inputs = await ok("get_cmake_inputs", { buildDir: "app/build-debug" });
    expect(inputs.inputs.map((i: Json) => i.path)).toEqual(
      expect.arrayContaining([path.join(ws, "app", "CMakeLists.txt"), path.join(ws, "app", "tools", "CMakeLists.txt")]),
    );
    expect(inputs.modifiedSinceConfigure).toEqual([]);
  });

  it("flags stale replies when CMake inputs change and picks up a fresh reply", async () => {
    const file = path.join(ws, "mathlib", "CMakeLists.txt");
    const future = new Date(Date.now() + 60_000);
    await utimes(file, future, future);
    const listed = await ok("list_projects");
    const math = listed.buildDirs.find((b: Json) => b.buildDir === path.join(ws, "mathlib", "build"));
    expect(math.fileApi.stale).toBe(true);
    expect(math.fileApi.modifiedInputs).toEqual([file]);

    const now = new Date();
    await utimes(file, now, now);
    execFileSync("cmake", [path.join(ws, "mathlib", "build")], { stdio: "ignore" });
    const refreshed = await ok("list_projects");
    const after = refreshed.buildDirs.find((b: Json) => b.buildDir === path.join(ws, "mathlib", "build"));
    expect(after.fileApi.stale).toBe(false);
  }, 60_000);

  it("explains missing compile_commands.json", async () => {
    await ok("register_build_dir", { buildDir: outsideNoCompileDb });
    const file = await ok("find_file_targets", { file: "mathlib/src/calc.c", buildDir: outsideNoCompileDb });
    expect(file.matches[0].compileCommands).toBeUndefined();
    expect(file.missingCompileCommands.buildDirs).toEqual([outsideNoCompileDb]);
    expect(file.missingCompileCommands.hint).toMatch(/CMAKE_EXPORT_COMPILE_COMMANDS/);

    const direct = await ok("get_compile_commands", { buildDir: outsideNoCompileDb });
    expect(direct.compileCommands).toBeNull();
  });

  it("never runs CMake or writes into build directories that lack a reply", async () => {
    const before = await listFilesRecursive(outsideNoReply);
    const reg = await ok("register_build_dir", { buildDir: outsideNoReply });
    expect(reg.sourceDir).toBe(path.join(ws, "mathlib"));

    const listed = await call("list_targets", { buildDir: outsideNoReply });
    expect(listed.isError).toBe(true);
    expect(listed.text).toMatch(/No CMake File API 'codemodel' reply found/);
    expect(listed.text).toMatch(/codemodel-v2/);

    expect(existsSync(path.join(outsideNoReply, ".cmake"))).toBe(false);
    expect(await listFilesRecursive(outsideNoReply)).toEqual(before);
  });

  it.runIf(hasNinja)("handles multi-config generators", async () => {
    await ok("register_build_dir", { buildDir: outsideMultiConfig });
    const summary = await ok("get_project_summary", { buildDir: outsideMultiConfig });
    expect(summary.configurations).toEqual(expect.arrayContaining(["Debug", "Release", "RelWithDebInfo"]));
    const release = await ok("get_target", { buildDir: outsideMultiConfig, target: "calc", configuration: "release" });
    expect(release.configuration).toBe("Release");
    expect(release.artifacts[0]).toMatch(/Release/);
    const bad = await call("list_targets", { buildDir: outsideMultiConfig, configuration: "Nope" });
    expect(bad.text).toMatch(/Configuration 'Nope' not found/);

    const file = await ok("find_file_targets", { file: "mathlib/src/calc.c", buildDir: outsideMultiConfig });
    const byConfig = Object.fromEntries(file.matches.map((m: Json) => [m.configuration, m.compileCommands]));
    expect(Object.keys(byConfig).sort()).toEqual(["Debug", "RelWithDebInfo", "Release"]);
    for (const [config, entries] of Object.entries(byConfig) as [string, Json[]][]) {
      expect(entries).toHaveLength(1);
      expect(entries[0].output).toContain(`.dir/${config}/`);
    }

    const releaseCmds = await ok("get_compile_commands", { buildDir: outsideMultiConfig, configuration: "Release" });
    expect(releaseCmds.entries.every((e: Json) => e.output.includes(".dir/Release/"))).toBe(true);
    expect(releaseCmds.matchCount).toBe(2);
  });
});

describe("MCP client roots", () => {
  it("scans the roots advertised by the client when no --root is given", async () => {
    const rootsClient = new Client({ name: "roots", version: "0.0.0" }, { capabilities: { roots: { listChanged: true } } });
    let roots = [{ uri: pathToFileURL(path.join(ws, "mathlib")).href, name: "mathlib" }];
    rootsClient.setRequestHandler(ListRootsRequestSchema, async () => ({ roots }));
    await rootsClient.connect(
      new StdioClientTransport({ command: process.execPath, args: [serverEntry], cwd: tmp, stderr: "inherit" }),
    );
    try {
      const listProjects = async () =>
        JSON.parse(((await rootsClient.callTool({ name: "list_projects", arguments: {} })) as Json).content[0].text);

      const first = await listProjects();
      expect(first.roots).toEqual([path.join(ws, "mathlib")]);
      expect(first.projects.map((p: Json) => p.name)).toEqual(["MathLib"]);

      roots = [{ uri: pathToFileURL(ws).href, name: "ws" }];
      await rootsClient.sendRootsListChanged();
      const second = await listProjects();
      expect(second.roots).toEqual([ws]);
      expect(second.projects.map((p: Json) => p.name)).toEqual(["App", "MathLib"]);
    } finally {
      await rootsClient.close();
    }
  }, 60_000);
});
