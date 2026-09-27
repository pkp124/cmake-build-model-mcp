import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdtemp, rm, utimes } from "node:fs/promises";
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
let outside: string;
let client: Client;

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

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "cmake-mcp-e2e-"));
  ws = path.join(tmp, "ws");
  outside = path.join(tmp, "outside-build");
  await cp(path.join(here, "fixtures", "workspace"), ws, { recursive: true });

  // A build directory configured outside the workspace and without our File API query.
  execFileSync("cmake", ["-S", path.join(ws, "mathlib"), "-B", outside, "-DCMAKE_BUILD_TYPE=Debug"], { stdio: "ignore" });

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
  it("advertises its tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "build",
        "configure",
        "find_file_targets",
        "get_cache_variables",
        "get_cmake_inputs",
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
  });

  it("discovers top-level projects but not subdirectories before anything is configured", async () => {
    const data = await ok("list_projects");
    expect(data.projects.map((p: Json) => [p.name, p.sourceDir])).toEqual([
      ["App", path.join(ws, "app")],
      ["MathLib", path.join(ws, "mathlib")],
    ]);
    expect(data.buildDirs).toEqual([]);
    expect((await call("list_targets")).text).toMatch(/No CMake build directories found/);
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

  it("configures multiple build directories for multiple projects", async () => {
    const debug = await ok("configure", { sourceDir: "app", buildDir: "app/build-debug", buildType: "Debug" });
    expect(debug.success).toBe(true);
    expect(debug.fileApi.availableObjects).toEqual(
      expect.arrayContaining([expect.stringMatching(/^codemodel-v2\./), expect.stringMatching(/^toolchains-v1\./)]),
    );

    const preset = await ok("configure", { sourceDir: "app", preset: "release" });
    expect(preset.buildDir).toBe(path.join(ws, "app", "out", "build", "release"));

    const math = await ok("configure", { sourceDir: path.join(ws, "mathlib") });
    expect(math.buildDir).toBe(path.join(ws, "mathlib", "build"));

    const data = await ok("list_projects", { rescan: true });
    expect(data.buildDirs.map((b: Json) => b.buildDir)).toEqual([
      path.join(ws, "app", "build-debug"),
      path.join(ws, "app", "out", "build", "release"),
      path.join(ws, "mathlib", "build"),
    ]);
    const app = data.projects.find((p: Json) => p.name === "App");
    expect(app.buildDirs).toHaveLength(2);
    for (const b of data.buildDirs) expect(b.fileApi.stale).toBe(false);
  }, 120_000);

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

  it("finds the targets that compile a file across all build directories", async () => {
    const data = await ok("find_file_targets", { file: "app/src/core.cpp" });
    expect(data.searchedBuildDirs).toHaveLength(2);
    expect(data.matches.map((m: Json) => [path.relative(ws, m.buildDir), m.configuration, m.target])).toEqual([
      ["app/build-debug", "Debug", "core"],
      ["app/out/build/release", "Release", "core"],
    ]);
    const cmd: string[] = data.matches[0].compileCommand;
    expect(cmd).toEqual(expect.arrayContaining(["-DCORE_VERSION=3", `-I${path.join(ws, "app", "include")}`, "-c"]));
    expect(cmd.at(-1)).toBe(path.join(ws, "app", "src", "core.cpp"));

    const header = await ok("find_file_targets", { file: path.join(ws, "mathlib", "src", "mathc.h") });
    expect(header.matches.every((m: Json) => m.matchedBy === "include-directory")).toBe(true);
    expect(header.matches.map((m: Json) => m.target).sort()).toEqual(["calc", "mathc"]);
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

  it("flags stale replies when CMake inputs change and refreshes on configure", async () => {
    const file = path.join(ws, "mathlib", "CMakeLists.txt");
    const future = new Date(Date.now() + 60_000);
    await utimes(file, future, future);
    const listed = await ok("list_projects");
    const math = listed.buildDirs.find((b: Json) => b.buildDir === path.join(ws, "mathlib", "build"));
    expect(math.fileApi.stale).toBe(true);
    expect(math.fileApi.modifiedInputs).toEqual([file]);

    const now = new Date();
    await utimes(file, now, now);
    const reconfigured = await ok("configure", { buildDir: "mathlib/build" });
    expect(reconfigured.success).toBe(true);
    expect(reconfigured.fileApi.stale).toBe(false);
  }, 60_000);

  it("auto-configures registered build directories that have no reply yet", async () => {
    const reg = await ok("register_build_dir", { buildDir: outside });
    expect(reg.sourceDir).toBe(path.join(ws, "mathlib"));
    const targets = await ok("list_targets", { buildDir: outside });
    expect(targets.targets.map((t: Json) => t.name).sort()).toEqual(["calc", "mathc"]);
  }, 60_000);

  it("builds a target", async () => {
    const result = await ok("build", { buildDir: "app/build-debug", targets: ["app_cli"], parallel: 2 });
    expect(result.success).toBe(true);
    const failed = await call("build", { buildDir: "app/build-debug", targets: ["does_not_exist"] });
    expect(failed.isError).toBe(true);
  }, 120_000);

  it.runIf(hasNinja)("handles multi-config generators", async () => {
    const mc = await ok("configure", {
      sourceDir: "mathlib",
      buildDir: "mathlib/build-mc",
      generator: "Ninja Multi-Config",
    });
    expect(mc.success).toBe(true);
    const summary = await ok("get_project_summary", { buildDir: "mathlib/build-mc" });
    expect(summary.configurations).toEqual(expect.arrayContaining(["Debug", "Release", "RelWithDebInfo"]));
    const release = await ok("get_target", { buildDir: "mathlib/build-mc", target: "calc", configuration: "release" });
    expect(release.configuration).toBe("Release");
    expect(release.artifacts[0]).toMatch(/Release/);
    const bad = await call("list_targets", { buildDir: "mathlib/build-mc", configuration: "Nope" });
    expect(bad.text).toMatch(/Configuration 'Nope' not found/);

    const file = await ok("find_file_targets", { file: "mathlib/src/calc.c", buildDir: "mathlib/build-mc" });
    expect(file.matches.map((m: Json) => m.configuration).sort()).toEqual(["Debug", "RelWithDebInfo", "Release"]);
  }, 120_000);
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
