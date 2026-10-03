import { promises as fs } from "node:fs";
import path from "node:path";
import { readCMakeCacheTxt } from "./cmake/cache.js";
import { CompileCommandsDb } from "./compileCommands.js";
import { findLatestReplyIndex, QUERY_HINT, Reply } from "./fileapi/reply.js";

export interface WorkspaceOptions {
  /** Build directories that already contain a CMake File API reply. */
  buildDirs: string[];
}

export interface BuildDirInfo {
  buildDir: string;
  sourceDir?: string;
  generator?: string;
  buildType?: string;
  configurationTypes?: string[];
}

export interface ReplyStatus {
  hasCodemodel: boolean;
  /** Path of compile_commands.json when the build directory has one. */
  compileCommands?: string;
  replyIndex?: string;
  generatedAt?: string;
  cmakeVersion?: string;
  availableObjects?: string[];
  /** Tracked CMake input files modified after the reply was generated. */
  modifiedInputs?: string[];
  stale?: boolean;
}

export class WorkspaceError extends Error {}

export class Workspace {
  private readonly requestedBuildDirs: string[];
  private readonly buildDirs = new Map<string, BuildDirInfo>();
  private readonly replies = new Map<string, Reply>();
  private readonly compileDbs = new Map<string, CompileCommandsDb>();
  private loaded: Promise<void> | undefined;

  constructor(readonly options: WorkspaceOptions) {
    this.requestedBuildDirs = [...new Set(options.buildDirs.map((d) => path.resolve(d)))];
  }

  async ensureLoaded(): Promise<void> {
    this.loaded ??= this.load();
    return this.loaded;
  }

  private async load(): Promise<void> {
    if (!this.requestedBuildDirs.length) {
      throw new WorkspaceError(
        "No build directory was given. Start the server with a build directory that already contains a CMake File API reply.",
      );
    }
    for (const dir of this.requestedBuildDirs) {
      await this.addBuildDir(dir);
    }
  }

  /** Records a build directory that has a CMake cache or a File API reply. */
  private async addBuildDir(buildDir: string): Promise<BuildDirInfo> {
    const cache = await readCMakeCacheTxt(path.join(buildDir, "CMakeCache.txt"));
    const reply = await this.loadReply(buildDir);
    if (!cache && !reply) {
      throw new WorkspaceError(
        `${buildDir} is not a CMake build directory (no CMakeCache.txt or File API reply).`,
      );
    }
    const configTypes = cache?.get("CMAKE_CONFIGURATION_TYPES")?.value;
    let sourceDir = cache?.get("CMAKE_HOME_DIRECTORY")?.value || undefined;
    let generator = cache?.get("CMAKE_GENERATOR")?.value || undefined;
    const buildType = cache?.get("CMAKE_BUILD_TYPE")?.value || undefined;
    if (reply) {
      generator ||= reply.index.cmake.generator.name;
      const codemodel = await reply.object("codemodel");
      if (codemodel) sourceDir ||= codemodel.paths.source;
    }
    const info: BuildDirInfo = {
      buildDir,
      sourceDir,
      generator,
      buildType,
      configurationTypes: configTypes ? configTypes.split(";").filter(Boolean) : undefined,
    };
    this.buildDirs.set(buildDir, info);
    return info;
  }

  async listBuildDirs(): Promise<BuildDirInfo[]> {
    await this.ensureLoaded();
    return [...this.buildDirs.values()].sort((a, b) => a.buildDir.localeCompare(b.buildDir));
  }

  getBuildDirInfo(buildDir: string): BuildDirInfo | undefined {
    return this.buildDirs.get(buildDir);
  }

  /**
   * Resolves `file` to an absolute path. Relative paths are resolved against the working
   * directory, then against each build's source directory when exactly one of those exists.
   */
  async resolveFile(file: string): Promise<string> {
    await this.ensureLoaded();
    if (path.isAbsolute(file)) return path.normalize(file);
    const fromCwd = path.resolve(file);
    if (await exists(fromCwd)) return fromCwd;
    const hits = new Set<string>();
    for (const info of this.buildDirs.values()) {
      if (!info.sourceDir) continue;
      const candidate = path.resolve(info.sourceDir, file);
      if (await exists(candidate)) hits.add(candidate);
    }
    if (hits.size === 1) return [...hits][0];
    if (hits.size > 1) {
      throw new WorkspaceError(
        `${file} exists in more than one source directory; pass an absolute path:\n${[...hits].sort().map((h) => `- ${h}`).join("\n")}`,
      );
    }
    return fromCwd;
  }

  /**
   * Maps a tool's `buildDir` argument to one of the directories given at startup.
   * An absolute path must match exactly. A relative path may be a unique suffix
   * (`build-debug`, `app/build-debug`). Omit the argument when only one build directory was given.
   */
  async resolveBuildDir(input: string | undefined): Promise<string> {
    await this.ensureLoaded();
    const all = await this.listBuildDirs();
    if (!input) {
      if (all.length === 1) return all[0].buildDir;
      throw new WorkspaceError(
        `Multiple build directories were given; pass \`buildDir\`:\n${all.map((b) => `- ${b.buildDir}`).join("\n")}`,
      );
    }
    const abs = path.resolve(input);
    if (this.buildDirs.has(abs)) return abs;
    if (!path.isAbsolute(input)) {
      const suffix = path.normalize(input);
      const matches = all.filter((b) => b.buildDir === suffix || b.buildDir.endsWith(path.sep + suffix));
      if (matches.length === 1) return matches[0].buildDir;
      if (matches.length > 1) {
        throw new WorkspaceError(
          `${input} matches several build directories; pick one:\n${matches.map((b) => `- ${b.buildDir}`).join("\n")}`,
        );
      }
    }
    throw new WorkspaceError(
      `${abs} is not one of the build directories given to the server:\n${all.map((b) => `- ${b.buildDir}`).join("\n")}`,
    );
  }

  /** Returns the existing File API reply of a build directory, which must contain `kind`. */
  async getReply(buildDir: string, kind: "codemodel" | "cache" | "cmakeFiles" | "toolchains" = "codemodel"): Promise<Reply> {
    const reply = await this.loadReply(buildDir);
    if (!reply || !reply.index.objects.some((o) => o.kind === kind)) {
      throw new WorkspaceError(`No CMake File API '${kind}' reply found in ${buildDir}.\n${QUERY_HINT}`);
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

  /** Loads `<buildDir>/compile_commands.json`, or returns undefined when there is none. */
  async compileCommands(buildDir: string): Promise<CompileCommandsDb | undefined> {
    const db = await CompileCommandsDb.load(buildDir, this.compileDbs.get(buildDir));
    if (db) this.compileDbs.set(buildDir, db);
    else this.compileDbs.delete(buildDir);
    return db;
  }

  /** Whether the build directory uses a multi-config generator (Ninja Multi-Config, Visual Studio, Xcode). */
  async isMultiConfig(buildDir: string): Promise<boolean> {
    const reply = await this.loadReply(buildDir);
    if (reply) return reply.index.cmake.generator.multiConfig;
    return Boolean(this.buildDirs.get(buildDir)?.configurationTypes?.length);
  }

  async replyStatus(buildDir: string): Promise<ReplyStatus> {
    const reply = await this.loadReply(buildDir);
    const compileCommands = (await exists(CompileCommandsDb.path(buildDir))) ? CompileCommandsDb.path(buildDir) : undefined;
    if (!reply) return { hasCodemodel: false, compileCommands };
    const modified = await this.modifiedInputs(reply);
    return {
      hasCodemodel: reply.index.objects.some((o) => o.kind === "codemodel"),
      compileCommands,
      replyIndex: reply.indexFile,
      generatedAt: new Date(reply.indexMtimeMs).toISOString(),
      cmakeVersion: reply.index.cmake.version.string,
      availableObjects: reply.availableKinds,
      modifiedInputs: modified.length ? modified.slice(0, 20) : undefined,
      stale: modified.length > 0,
    };
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
