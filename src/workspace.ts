import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { readCMakeCacheTxt } from "./cmake/cache.js";
import { loadPresets, type Presets } from "./cmake/presets.js";
import { run, type RunResult } from "./cmake/runner.js";
import { findLatestReplyIndex, hasQuery, Reply, writeQuery } from "./fileapi/reply.js";

export type AutoConfigurePolicy = "never" | "missing" | "stale";

export interface WorkspaceOptions {
  roots: string[];
  cmakePath: string;
  maxScanDepth: number;
  autoConfigure: AutoConfigurePolicy;
  configureTimeoutMs: number;
  buildTimeoutMs: number;
  extraBuildDirs?: string[];
}

export interface BuildDirInfo {
  buildDir: string;
  sourceDir?: string;
  generator?: string;
  buildType?: string;
  configurationTypes?: string[];
  cmakeCommand?: string;
  /** How this build directory was found. */
  origin: "scan" | "preset" | "registered" | "configured";
}

export interface ProjectInfo {
  sourceDir: string;
  name?: string;
  hasPresets: boolean;
  /** True when found under a workspace root as a top-level CMakeLists.txt. */
  discoveredByScan: boolean;
}

export interface ReplyStatus {
  hasQuery: boolean;
  replyIndex?: string;
  generatedAt?: string;
  cmakeVersion?: string;
  availableObjects?: string[];
  /** Tracked CMake input files modified after the reply was generated. */
  modifiedInputs?: string[];
  stale?: boolean;
}

const SKIP_DIR_NAMES = new Set(["node_modules", "__pycache__", "CMakeFiles", "_deps", "venv", ".venv"]);
const MAX_SCANNED_DIRS = 50_000;

export class WorkspaceError extends Error {}

export class Workspace {
  private roots: string[];
  private readonly buildDirs = new Map<string, BuildDirInfo>();
  private readonly projects = new Map<string, ProjectInfo>();
  private readonly replies = new Map<string, Reply>();
  private scanned: Promise<void> | undefined;
  private pendingRoots: Promise<void> | undefined;
  private readonly configureLocks = new Map<string, Promise<unknown>>();

  constructor(readonly options: WorkspaceOptions) {
    this.roots = options.roots.map((r) => path.resolve(r));
  }

  getRoots(): string[] {
    return [...this.roots];
  }

  setRoots(roots: string[]): void {
    this.roots = roots.map((r) => path.resolve(r));
    this.scanned = undefined;
  }

  /** Defers scanning until `roots` resolves; an undefined or empty result keeps the current roots. */
  setRootsAsync(roots: Promise<string[] | undefined>): void {
    const pending = roots
      .catch(() => undefined)
      .then((dirs) => {
        if (this.pendingRoots === pending) this.pendingRoots = undefined;
        if (dirs?.length) this.setRoots(dirs);
      });
    this.pendingRoots = pending;
  }

  async ensureScanned(): Promise<void> {
    while (this.pendingRoots) await this.pendingRoots;
    this.scanned ??= this.scan();
    return this.scanned;
  }

  async rescan(): Promise<void> {
    while (this.pendingRoots) await this.pendingRoots;
    this.scanned = this.scan();
    return this.scanned;
  }

  private async scan(): Promise<void> {
    for (const [dir, info] of this.buildDirs) {
      if (info.origin === "scan" || info.origin === "preset") this.buildDirs.delete(dir);
    }
    for (const [dir, info] of this.projects) {
      if (info.discoveredByScan) this.projects.delete(dir);
    }

    const budget = { remaining: MAX_SCANNED_DIRS };
    for (const root of this.roots) {
      await this.scanDir(root, 0, false, budget);
    }
    for (const dir of this.options.extraBuildDirs ?? []) {
      await this.addBuildDir(path.resolve(dir), "registered");
    }
    // Build directories may point at sources outside the roots, and presets may put
    // build trees outside the roots, so cross-link both ways.
    for (const info of [...this.buildDirs.values()]) {
      if (info.sourceDir) await this.addProject(info.sourceDir, false);
    }
    for (const project of [...this.projects.values()]) {
      if (!project.hasPresets) continue;
      const presets = await loadPresets(project.sourceDir);
      for (const preset of presets.configurePresets) {
        if (preset.binaryDir && !this.buildDirs.has(preset.binaryDir)) {
          await this.addBuildDir(preset.binaryDir, "preset");
        }
      }
    }
  }

  private async scanDir(dir: string, depth: number, insideProject: boolean, budget: { remaining: number }) {
    if (budget.remaining-- <= 0) return;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const files = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
    if (files.has("CMakeCache.txt")) {
      await this.addBuildDir(dir, "scan");
      return;
    }
    let childInsideProject = insideProject;
    if (files.has("CMakeLists.txt") && !insideProject) {
      await this.addProject(dir, true);
      childInsideProject = true;
    }
    if (depth >= this.options.maxScanDepth) return;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP_DIR_NAMES.has(entry.name)) continue;
      await this.scanDir(path.join(dir, entry.name), depth + 1, childInsideProject, budget);
    }
  }

  private async addProject(sourceDir: string, discoveredByScan: boolean): Promise<void> {
    const existing = this.projects.get(sourceDir);
    if (existing) {
      existing.discoveredByScan ||= discoveredByScan;
      return;
    }
    let name: string | undefined;
    try {
      const text = await fs.readFile(path.join(sourceDir, "CMakeLists.txt"), "utf8");
      name = /^\s*project\s*\(\s*"?([A-Za-z0-9_.+\-]+)/im.exec(text)?.[1];
    } catch {
      return;
    }
    const hasPresets = (await exists(path.join(sourceDir, "CMakePresets.json"))) ||
      (await exists(path.join(sourceDir, "CMakeUserPresets.json")));
    this.projects.set(sourceDir, { sourceDir, name, hasPresets, discoveredByScan });
  }

  /** Records a build directory if it contains a CMakeCache.txt. Returns its info or undefined. */
  private async addBuildDir(buildDir: string, origin: BuildDirInfo["origin"]): Promise<BuildDirInfo | undefined> {
    const cache = await readCMakeCacheTxt(path.join(buildDir, "CMakeCache.txt"));
    if (!cache) return undefined;
    const previous = this.buildDirs.get(buildDir);
    const configTypes = cache.get("CMAKE_CONFIGURATION_TYPES")?.value;
    const info: BuildDirInfo = {
      buildDir,
      sourceDir: cache.get("CMAKE_HOME_DIRECTORY")?.value || undefined,
      generator: cache.get("CMAKE_GENERATOR")?.value || undefined,
      buildType: cache.get("CMAKE_BUILD_TYPE")?.value || undefined,
      configurationTypes: configTypes ? configTypes.split(";").filter(Boolean) : undefined,
      cmakeCommand: cache.get("CMAKE_COMMAND")?.value || undefined,
      origin: previous && previous.origin !== "scan" && previous.origin !== "preset" ? previous.origin : origin,
    };
    this.buildDirs.set(buildDir, info);
    return info;
  }

  async registerBuildDir(buildDir: string): Promise<BuildDirInfo> {
    await this.ensureScanned();
    const abs = this.resolvePath(buildDir);
    const info = await this.addBuildDir(abs, "registered");
    if (!info) throw new WorkspaceError(`${abs} is not a CMake build directory (no CMakeCache.txt).`);
    if (info.sourceDir) await this.addProject(info.sourceDir, false);
    return info;
  }

  async listProjects(): Promise<{ projects: ProjectInfo[]; buildDirs: BuildDirInfo[] }> {
    await this.ensureScanned();
    return {
      projects: [...this.projects.values()].sort((a, b) => a.sourceDir.localeCompare(b.sourceDir)),
      buildDirs: [...this.buildDirs.values()].sort((a, b) => a.buildDir.localeCompare(b.buildDir)),
    };
  }

  async allBuildDirs(): Promise<BuildDirInfo[]> {
    return (await this.listProjects()).buildDirs;
  }

  getBuildDirInfo(buildDir: string): BuildDirInfo | undefined {
    return this.buildDirs.get(buildDir);
  }

  /** Resolves a relative path against the first root it exists under (or the first root). */
  resolvePath(p: string): string {
    if (path.isAbsolute(p)) return path.normalize(p);
    for (const root of this.roots) {
      const candidate = path.resolve(root, p);
      if (this.buildDirs.has(candidate) || this.projects.has(candidate)) return candidate;
    }
    return path.resolve(this.roots[0] ?? process.cwd(), p);
  }

  /**
   * Maps the user-supplied `buildDir` argument to a known build directory. Accepts a build
   * directory, a source directory with exactly one build directory, or nothing when the
   * workspace has exactly one build directory.
   */
  async resolveBuildDir(input: string | undefined): Promise<string> {
    await this.ensureScanned();
    const all = [...this.buildDirs.values()];
    if (!input) {
      if (all.length === 1) return all[0].buildDir;
      if (all.length === 0) {
        throw new WorkspaceError(
          "No CMake build directories found in the workspace. Use the `configure` tool to create one, " +
            "or `register_build_dir` to add one outside the workspace roots.",
        );
      }
      throw new WorkspaceError(
        `Multiple build directories exist; pass \`buildDir\`. Known build directories:\n${all.map((b) => `- ${b.buildDir}`).join("\n")}`,
      );
    }
    const abs = this.resolvePath(input);
    if (this.buildDirs.has(abs)) return abs;
    if (await exists(path.join(abs, "CMakeCache.txt"))) {
      await this.addBuildDir(abs, "registered");
      return abs;
    }
    const forSource = all.filter((b) => b.sourceDir && path.normalize(b.sourceDir) === abs);
    if (forSource.length === 1) return forSource[0].buildDir;
    if (forSource.length > 1) {
      throw new WorkspaceError(
        `${abs} is a source directory with several build directories; pick one:\n${forSource.map((b) => `- ${b.buildDir}`).join("\n")}`,
      );
    }
    throw new WorkspaceError(`${abs} is not a known CMake build directory or configured source directory.`);
  }

  async presets(sourceDir: string): Promise<Presets> {
    return loadPresets(this.resolvePath(sourceDir));
  }

  /** Returns a File API reply containing `kind`, configuring the build directory if policy allows. */
  async getReply(buildDir: string, kind: "codemodel" | "cache" | "cmakeFiles" | "toolchains" = "codemodel"): Promise<Reply> {
    await writeQuery(buildDir);
    let reply = await this.loadReply(buildDir);
    const policy = this.options.autoConfigure;
    const missing = !reply || !reply.index.objects.some((o) => o.kind === kind);
    const stale = !missing && policy === "stale" && (await this.modifiedInputs(reply!)).length > 0;
    if ((missing && policy !== "never") || stale) {
      const result = await this.reconfigure(buildDir);
      if (result.exitCode !== 0) {
        throw new WorkspaceError(`Automatic CMake configure of ${buildDir} failed:\n${result.output.slice(-4000)}`);
      }
      reply = await this.loadReply(buildDir);
    }
    if (!reply || !reply.index.objects.some((o) => o.kind === kind)) {
      throw new WorkspaceError(
        `No File API '${kind}' reply in ${buildDir}. The query has been written; run the \`configure\` tool ` +
          "(or re-run CMake yourself) to generate it.",
      );
    }
    return reply;
  }

  private async loadReply(buildDir: string): Promise<Reply | undefined> {
    const latest = await findLatestReplyIndex(buildDir);
    if (!latest) return undefined;
    const cached = this.replies.get(buildDir);
    if (cached && cached.indexFile === latest.file && cached.indexMtimeMs === latest.mtimeMs) return cached;
    const reply = await Reply.load(buildDir, latest);
    this.replies.set(buildDir, reply);
    return reply;
  }

  async modifiedInputs(reply: Reply): Promise<string[]> {
    const cmakeFiles = await reply.object("cmakeFiles");
    if (!cmakeFiles) return [];
    const modified: string[] = [];
    await Promise.all(
      cmakeFiles.inputs
        .filter((i) => !i.isGenerated && !i.isExternal && !i.isCMake)
        .map(async (input) => {
          const file = path.resolve(cmakeFiles.paths.source, input.path);
          try {
            if ((await fs.stat(file)).mtimeMs > reply.indexMtimeMs) modified.push(file);
          } catch {
            modified.push(file);
          }
        }),
    );
    return modified.sort();
  }

  async replyStatus(buildDir: string): Promise<ReplyStatus> {
    const status: ReplyStatus = { hasQuery: await hasQuery(buildDir) };
    const reply = await this.loadReply(buildDir);
    if (!reply) return status;
    const modified = await this.modifiedInputs(reply);
    return {
      ...status,
      replyIndex: reply.indexFile,
      generatedAt: new Date(reply.indexMtimeMs).toISOString(),
      cmakeVersion: reply.index.cmake.version.string,
      availableObjects: reply.availableKinds,
      modifiedInputs: modified.length ? modified.slice(0, 20) : undefined,
      stale: modified.length > 0,
    };
  }

  private cmakeFor(buildDir: string | undefined): string {
    const fromCache = buildDir ? this.buildDirs.get(buildDir)?.cmakeCommand : undefined;
    return fromCache ?? this.options.cmakePath;
  }

  private async withLock<T>(buildDir: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.configureLocks.get(buildDir) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(fn);
    this.configureLocks.set(buildDir, next);
    try {
      return await next;
    } finally {
      if (this.configureLocks.get(buildDir) === next) this.configureLocks.delete(buildDir);
    }
  }

  /** Re-runs CMake on an existing build directory using its cached settings. */
  reconfigure(buildDir: string, extraArgs: string[] = []): Promise<RunResult> {
    return this.withLock(buildDir, async () => {
      await writeQuery(buildDir);
      const result = await run(this.cmakeFor(buildDir), [...extraArgs, buildDir], {
        cwd: buildDir,
        timeoutMs: this.options.configureTimeoutMs,
      });
      await this.addBuildDir(buildDir, "configured");
      return result;
    });
  }

  async configure(opts: {
    sourceDir?: string;
    buildDir?: string;
    preset?: string;
    generator?: string;
    buildType?: string;
    cacheVariables?: Record<string, string>;
    extraArgs?: string[];
  }): Promise<{ buildDir: string; result: RunResult }> {
    await this.ensureScanned();
    const defs = Object.entries(opts.cacheVariables ?? {}).map(([k, v]) => `-D${k}=${v}`);
    if (opts.buildType) defs.push(`-DCMAKE_BUILD_TYPE=${opts.buildType}`);
    const genArgs = opts.generator ? ["-G", opts.generator] : [];
    const extra = opts.extraArgs ?? [];

    if (opts.preset) {
      if (!opts.sourceDir) throw new WorkspaceError("`sourceDir` is required when configuring with a preset.");
      const sourceDir = this.resolvePath(opts.sourceDir);
      const presets = await loadPresets(sourceDir);
      const preset = presets.configurePresets.find((p) => p.name === opts.preset);
      if (!preset) {
        throw new WorkspaceError(
          `Configure preset '${opts.preset}' not found in ${sourceDir}. Available: ${presets.configurePresets.map((p) => p.name).join(", ") || "(none)"}`,
        );
      }
      const buildDir = opts.buildDir ? this.resolvePath(opts.buildDir) : preset.binaryDir;
      if (!buildDir) {
        throw new WorkspaceError(`Preset '${opts.preset}' has no binaryDir; pass \`buildDir\` explicitly.`);
      }
      const args = ["--preset", opts.preset, ...(opts.buildDir ? ["-B", buildDir] : []), ...genArgs, ...defs, ...extra];
      return this.runConfigure(buildDir, sourceDir, args);
    }

    if (opts.sourceDir) {
      const sourceDir = this.resolvePath(opts.sourceDir);
      if (!(await exists(path.join(sourceDir, "CMakeLists.txt")))) {
        throw new WorkspaceError(`${sourceDir} has no CMakeLists.txt.`);
      }
      const buildDir = opts.buildDir ? this.resolvePath(opts.buildDir) : path.join(sourceDir, "build");
      return this.runConfigure(buildDir, sourceDir, ["-S", sourceDir, "-B", buildDir, ...genArgs, ...defs, ...extra]);
    }

    const buildDir = await this.resolveBuildDir(opts.buildDir);
    if (genArgs.length) throw new WorkspaceError("Changing the generator of an existing build directory is not supported.");
    const result = await this.reconfigure(buildDir, [...defs, ...extra]);
    return { buildDir, result };
  }

  private runConfigure(buildDir: string, cwd: string, args: string[]): Promise<{ buildDir: string; result: RunResult }> {
    return this.withLock(buildDir, async () => {
      await writeQuery(buildDir);
      const result = await run(this.cmakeFor(buildDir), args, { cwd, timeoutMs: this.options.configureTimeoutMs });
      const info = await this.addBuildDir(buildDir, "configured");
      if (info?.sourceDir) await this.addProject(info.sourceDir, false);
      return { buildDir, result };
    });
  }

  async build(opts: {
    buildDir?: string;
    targets?: string[];
    configuration?: string;
    parallel?: number;
    clean?: boolean;
    timeoutMs?: number;
  }): Promise<{ buildDir: string; result: RunResult }> {
    const buildDir = await this.resolveBuildDir(opts.buildDir);
    const args = ["--build", buildDir];
    if (opts.configuration) args.push("--config", opts.configuration);
    if (opts.targets?.length) args.push("--target", ...opts.targets);
    if (opts.parallel !== undefined) args.push("--parallel", String(opts.parallel));
    if (opts.clean) args.push("--clean-first");
    const result = await this.withLock(buildDir, () =>
      run(this.cmakeFor(buildDir), args, { cwd: buildDir, timeoutMs: opts.timeoutMs ?? this.options.buildTimeoutMs }),
    );
    return { buildDir, result };
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
