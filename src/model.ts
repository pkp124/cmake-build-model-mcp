import path from "node:path";
import { entryMatches, type CompileCommand, type CompileCommandsDb } from "./compileCommands.js";
import type { Reply } from "./fileapi/reply.js";
import type {
  BacktraceGraph,
  Codemodel,
  CodemodelConfiguration,
  CodemodelTargetRef,
  CompileGroup,
  Target,
} from "./fileapi/types.js";

export class ModelError extends Error {}

export function selectConfiguration(
  codemodel: Codemodel,
  requested: string | undefined,
  preferred?: string,
): CodemodelConfiguration {
  const configs = codemodel.configurations;
  if (requested !== undefined) {
    const match = configs.find((c) => c.name.toLowerCase() === requested.toLowerCase());
    if (!match) {
      throw new ModelError(
        `Configuration '${requested}' not found. Available: ${configs.map((c) => c.name || '""').join(", ")}`,
      );
    }
    return match;
  }
  if (preferred) {
    const match = configs.find((c) => c.name.toLowerCase() === preferred.toLowerCase());
    if (match) return match;
  }
  return configs[0];
}

function abs(base: string, p: string): string {
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(base, p);
}

export function resolveBacktrace(graph: BacktraceGraph, index: number | undefined, sourceDir: string): string[] {
  const frames: string[] = [];
  let current = index;
  const seen = new Set<number>();
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const node = graph.nodes[current];
    if (!node) break;
    const file = abs(sourceDir, graph.files[node.file]);
    const command = node.command !== undefined ? graph.commands[node.command] : undefined;
    frames.push(`${file}${node.line !== undefined ? `:${node.line}` : ""}${command ? ` (${command})` : ""}`);
    current = node.parent;
  }
  return frames;
}

export function findTargetRef(config: CodemodelConfiguration, nameOrId: string): CodemodelTargetRef {
  const ref = config.targets.find((t) => t.name === nameOrId || t.id === nameOrId);
  if (ref) return ref;
  const lower = nameOrId.toLowerCase();
  const fuzzy = config.targets.filter((t) => t.name.toLowerCase().includes(lower));
  const hint = fuzzy.length
    ? ` Did you mean: ${fuzzy.slice(0, 10).map((t) => t.name).join(", ")}?`
    : ` Use \`list_targets\` to see available targets.`;
  throw new ModelError(`Target '${nameOrId}' not found in configuration '${config.name}'.${hint}`);
}

export async function summarize(reply: Reply, config: CodemodelConfiguration) {
  const codemodel = (await reply.object("codemodel"))!;
  const targets = await Promise.all(config.targets.map((t) => reply.target(t.jsonFile)));
  const byType: Record<string, string[]> = {};
  for (const t of targets) (byType[t.type] ??= []).push(t.name);
  return {
    buildDir: codemodel.paths.build,
    sourceDir: codemodel.paths.source,
    cmake: {
      version: reply.index.cmake.version.string,
      command: reply.index.cmake.paths.cmake,
      generator: reply.index.cmake.generator,
    },
    configurations: codemodel.configurations.map((c) => c.name),
    configuration: config.name,
    projects: config.projects.map((p) => ({
      name: p.name,
      parent: p.parentIndex !== undefined ? config.projects[p.parentIndex].name : undefined,
      sourceDir: abs(codemodel.paths.source, config.directories[p.directoryIndexes[0]].source),
      targetCount: p.targetIndexes?.length ?? 0,
    })),
    directoryCount: config.directories.length,
    targetsByType: byType,
  };
}

export async function listTargets(
  reply: Reply,
  config: CodemodelConfiguration,
  filter: { type?: string[]; name?: string; project?: string; directory?: string },
) {
  const codemodel = (await reply.object("codemodel"))!;
  const nameRe = filter.name ? globOrRegex(filter.name) : undefined;
  const dirFilter = filter.directory ? path.resolve(codemodel.paths.source, filter.directory) : undefined;
  const results = [];
  for (const ref of config.targets) {
    if (nameRe && !nameRe.test(ref.name)) continue;
    const project = config.projects[ref.projectIndex];
    if (filter.project && project.name !== filter.project) continue;
    const directory = abs(codemodel.paths.source, config.directories[ref.directoryIndex].source);
    if (dirFilter && !isWithin(directory, dirFilter)) continue;
    const target = await reply.target(ref.jsonFile);
    if (filter.type?.length && !filter.type.includes(target.type)) continue;
    results.push({
      name: target.name,
      type: target.type,
      project: project.name,
      directory,
      artifacts: target.artifacts?.map((a) => abs(codemodel.paths.build, a.path)),
      sourceCount: target.sources?.length ?? 0,
      languages: [...new Set((target.compileGroups ?? []).map((g) => g.language))],
      isGeneratorProvided: target.isGeneratorProvided || undefined,
      folder: target.folder?.name,
    });
  }
  return results;
}

export interface TargetDetailOptions {
  includeSources: boolean;
  maxSources: number;
  includeBacktraces: boolean;
}

export async function targetDetails(
  reply: Reply,
  config: CodemodelConfiguration,
  nameOrId: string,
  opts: TargetDetailOptions,
) {
  const codemodel = (await reply.object("codemodel"))!;
  const { source: srcRoot, build: buildRoot } = codemodel.paths;
  const ref = findTargetRef(config, nameOrId);
  const t = await reply.target(ref.jsonFile);
  const bt = (i: number | undefined) =>
    opts.includeBacktraces && i !== undefined ? resolveBacktrace(t.backtraceGraph, i, srcRoot) : undefined;
  const idToName = new Map(config.targets.map((r) => [r.id, r.name]));

  const sources = t.sources ?? [];
  const shownSources = opts.includeSources ? sources.slice(0, opts.maxSources) : [];

  return {
    name: t.name,
    id: t.id,
    type: t.type,
    project: config.projects[ref.projectIndex].name,
    definedAt: t.backtrace !== undefined ? resolveBacktrace(t.backtraceGraph, t.backtrace, srcRoot)[0] : undefined,
    definitionBacktrace: bt(t.backtrace),
    targetSourceDir: abs(srcRoot, t.paths.source),
    targetBuildDir: abs(buildRoot, t.paths.build),
    nameOnDisk: t.nameOnDisk,
    artifacts: t.artifacts?.map((a) => abs(buildRoot, a.path)),
    folder: t.folder?.name,
    isGeneratorProvided: t.isGeneratorProvided || undefined,
    dependencies: t.dependencies?.map((d) => ({
      name: idToName.get(d.id) ?? d.id,
      backtrace: bt(d.backtrace),
    })),
    link: t.link && {
      language: t.link.language,
      lto: t.link.lto,
      sysroot: t.link.sysroot?.path,
      commandFragments: t.link.commandFragments?.map((f) => ({ fragment: f.fragment, role: f.role })),
    },
    archive: t.archive && {
      lto: t.archive.lto,
      commandFragments: t.archive.commandFragments?.map((f) => ({ fragment: f.fragment, role: f.role })),
    },
    install: t.install && {
      prefix: t.install.prefix.path,
      destinations: t.install.destinations.map((d) => ({ path: d.path, backtrace: bt(d.backtrace) })),
    },
    launchers: t.launchers,
    fileSets: t.fileSets,
    compileGroups: t.compileGroups?.map((g, index) => ({
      index,
      ...describeCompileGroup(g, t, opts.includeBacktraces, srcRoot),
      sourceCount: g.sourceIndexes.length,
    })),
    sourceCount: sources.length,
    sources: opts.includeSources
      ? shownSources.map((s) => ({
          path: abs(srcRoot, s.path),
          compileGroup: s.compileGroupIndex,
          sourceGroup: s.sourceGroupIndex !== undefined ? t.sourceGroups?.[s.sourceGroupIndex]?.name : undefined,
          isGenerated: s.isGenerated || undefined,
          backtrace: bt(s.backtrace),
        }))
      : undefined,
    sourcesTruncated: opts.includeSources && sources.length > shownSources.length ? true : undefined,
  };
}

function describeCompileGroup(g: CompileGroup, t: Target, includeBacktraces: boolean, srcRoot: string) {
  const bt = (i: number | undefined) =>
    includeBacktraces && i !== undefined ? resolveBacktrace(t.backtraceGraph, i, srcRoot) : undefined;
  return {
    language: g.language,
    languageStandard: g.languageStandard?.standard,
    compileFlags: g.compileCommandFragments?.map((f) => f.fragment),
    defines: g.defines?.map((d) => (includeBacktraces ? { define: d.define, backtrace: bt(d.backtrace) } : d.define)),
    includes: g.includes?.map((i) =>
      includeBacktraces
        ? { path: i.path, isSystem: i.isSystem || undefined, backtrace: bt(i.backtrace) }
        : { path: i.path, isSystem: i.isSystem || undefined },
    ),
    frameworks: g.frameworks?.map((f) => ({ path: f.path, isSystem: f.isSystem || undefined })),
    precompileHeaders: g.precompileHeaders?.map((p) => p.header),
    sysroot: g.sysroot?.path,
  };
}

export async function dependencyGraph(
  reply: Reply,
  config: CodemodelConfiguration,
  nameOrId: string,
  opts: { direction: "dependencies" | "dependents"; transitive: boolean },
) {
  const root = findTargetRef(config, nameOrId);
  const targets = new Map<string, Target>();
  await Promise.all(config.targets.map(async (r) => targets.set(r.id, await reply.target(r.jsonFile))));

  const edges = new Map<string, string[]>();
  for (const t of targets.values()) {
    for (const d of t.dependencies ?? []) {
      const [from, to] = opts.direction === "dependencies" ? [t.id, d.id] : [d.id, t.id];
      (edges.get(from) ?? edges.set(from, []).get(from)!).push(to);
    }
  }

  const name = (id: string) => targets.get(id)?.name ?? id;
  const type = (id: string) => targets.get(id)?.type;
  if (!opts.transitive) {
    return {
      target: root.name,
      direction: opts.direction,
      [opts.direction]: (edges.get(root.id) ?? []).map((id) => ({ name: name(id), type: type(id) })),
    };
  }

  const graph: Record<string, string[]> = {};
  const order: string[] = [];
  const visit = (id: string) => {
    if (graph[name(id)]) return;
    const next = edges.get(id) ?? [];
    graph[name(id)] = next.map(name);
    order.push(id);
    next.forEach(visit);
  };
  visit(root.id);
  return {
    target: root.name,
    direction: opts.direction,
    [opts.direction]: order.slice(1).map((id) => ({ name: name(id), type: type(id) })),
    graph,
  };
}

export interface FileMatch {
  buildDir: string;
  configuration: string;
  target: string;
  targetType: string;
  matchedBy: "source" | "include-directory";
  isGenerated?: boolean;
  compileGroup?: ReturnType<typeof describeCompileGroup>;
  /** Matching entries of the build directory's compile_commands.json, if it has one. */
  compileCommands?: CompileCommand[];
}

/**
 * Finds the targets that compile `file` in every configuration of a reply. Headers are rarely
 * listed as target sources, so when no target lists the file we fall back to targets whose
 * include directories contain it.
 */
export async function findFile(
  reply: Reply,
  file: string,
  opts: { configuration?: string; includeBacktraces: boolean; compileCommands?: CompileCommandsDb },
): Promise<FileMatch[]> {
  const codemodel = (await reply.object("codemodel"))!;
  const multiConfig = reply.index.cmake.generator.multiConfig;
  const { source: srcRoot, build: buildRoot } = codemodel.paths;
  const target = path.normalize(file);
  const configs = opts.configuration
    ? [selectConfiguration(codemodel, opts.configuration)]
    : codemodel.configurations;

  const direct: FileMatch[] = [];
  const viaInclude: FileMatch[] = [];
  for (const config of configs) {
    for (const ref of config.targets) {
      const t = await reply.target(ref.jsonFile);
      const source = t.sources?.find((s) => abs(srcRoot, s.path) === target);
      if (source) {
        const group = source.compileGroupIndex !== undefined ? t.compileGroups?.[source.compileGroupIndex] : undefined;
        direct.push({
          buildDir: buildRoot,
          configuration: config.name,
          target: t.name,
          targetType: t.type,
          matchedBy: "source",
          isGenerated: source.isGenerated || undefined,
          compileGroup: group && describeCompileGroup(group, t, opts.includeBacktraces, srcRoot),
          compileCommands: opts.compileCommands
            ?.forFile(target)
            .filter((e) => entryMatches(e, t.name, multiConfig ? config.name : undefined)),
        });
        continue;
      }
      const group = t.compileGroups?.find((g) => g.includes?.some((i) => isWithin(target, path.normalize(i.path))));
      if (group) {
        viaInclude.push({
          buildDir: buildRoot,
          configuration: config.name,
          target: t.name,
          targetType: t.type,
          matchedBy: "include-directory",
          compileGroup: describeCompileGroup(group, t, opts.includeBacktraces, srcRoot),
        });
      }
    }
  }
  return direct.length ? direct : viaInclude;
}

export function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Accepts either a glob (`*`, `?`) or, when wrapped in slashes, a regular expression. */
export function globOrRegex(pattern: string): RegExp {
  const regex = /^\/(.*)\/([a-z]*)$/.exec(pattern);
  if (regex) return new RegExp(regex[1], regex[2]);
  if (!/[*?]/.test(pattern)) return new RegExp(escapeRegex(pattern), "i");
  const source = pattern.split("*").map((part) => part.split("?").map(escapeRegex).join(".")).join(".*");
  return new RegExp(`^${source}$`, "i");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
