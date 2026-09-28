import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

interface RawConfigurePreset {
  name: string;
  displayName?: string;
  description?: string;
  hidden?: boolean;
  inherits?: string | string[];
  generator?: string;
  binaryDir?: string;
  installDir?: string;
  toolchainFile?: string;
  cacheVariables?: Record<string, unknown>;
}

interface RawBuildPreset {
  name: string;
  displayName?: string;
  hidden?: boolean;
  inherits?: string | string[];
  configurePreset?: string;
  configuration?: string;
  targets?: string | string[];
}

interface RawPresetsFile {
  version?: number;
  include?: string[];
  configurePresets?: RawConfigurePreset[];
  buildPresets?: RawBuildPreset[];
}

export interface ConfigurePreset {
  name: string;
  displayName?: string;
  description?: string;
  generator?: string;
  /** Absolute binary directory after macro expansion, if it could be determined. */
  binaryDir?: string;
  toolchainFile?: string;
  cacheVariables: Record<string, unknown>;
  file: string;
}

export interface BuildPreset {
  name: string;
  displayName?: string;
  configurePreset?: string;
  configuration?: string;
  targets?: string[];
  file: string;
}

export interface Presets {
  files: string[];
  configurePresets: ConfigurePreset[];
  buildPresets: BuildPreset[];
  errors: string[];
}

const HOST_SYSTEM_NAME: Record<string, string> = { linux: "Linux", darwin: "Darwin", win32: "Windows" };

async function loadFile(
  file: string,
  seen: Set<string>,
  out: { file: string; data: RawPresetsFile }[],
  errors: string[],
): Promise<void> {
  const resolved = path.resolve(file);
  if (seen.has(resolved)) return;
  seen.add(resolved);
  let data: RawPresetsFile;
  try {
    data = JSON.parse(await fs.readFile(resolved, "utf8")) as RawPresetsFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") errors.push(`${resolved}: ${(err as Error).message}`);
    return;
  }
  out.push({ file: resolved, data });
  for (const inc of data.include ?? []) {
    await loadFile(path.resolve(path.dirname(resolved), inc), seen, out, errors);
  }
}

function toList(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function expandMacros(value: string, vars: Record<string, string>): string {
  return value
    .replace(/\$env\{([^}]*)\}/g, (_, name: string) => process.env[name] ?? "")
    .replace(/\$penv\{([^}]*)\}/g, (_, name: string) => process.env[name] ?? "")
    .replace(/\$\{([^}]*)\}/g, (whole, name: string) => vars[name] ?? whole);
}

/** Resolves a preset's field by walking `inherits` depth-first, first definition wins. */
function resolveInherited<T extends { name: string; inherits?: string | string[] }, K extends keyof T>(
  preset: T,
  key: K,
  byName: Map<string, T>,
  visiting = new Set<string>(),
): T[K] | undefined {
  if (preset[key] !== undefined) return preset[key];
  if (visiting.has(preset.name)) return undefined;
  visiting.add(preset.name);
  for (const parentName of toList(preset.inherits)) {
    const parent = byName.get(parentName);
    if (!parent) continue;
    const value = resolveInherited(parent, key, byName, visiting);
    if (value !== undefined) return value;
  }
  return undefined;
}

function mergedCacheVariables(
  preset: RawConfigurePreset,
  byName: Map<string, RawConfigurePreset>,
  visiting = new Set<string>(),
): Record<string, unknown> {
  if (visiting.has(preset.name)) return {};
  visiting.add(preset.name);
  const result: Record<string, unknown> = {};
  // Earlier parents take precedence over later ones, and the preset itself over all parents.
  for (const parentName of toList(preset.inherits).reverse()) {
    const parent = byName.get(parentName);
    if (parent) Object.assign(result, mergedCacheVariables(parent, byName, visiting));
  }
  return Object.assign(result, preset.cacheVariables ?? {});
}

/** Loads CMakePresets.json and CMakeUserPresets.json (with includes) for a source directory. */
export async function loadPresets(sourceDir: string): Promise<Presets> {
  const loaded: { file: string; data: RawPresetsFile }[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  await loadFile(path.join(sourceDir, "CMakePresets.json"), seen, loaded, errors);
  await loadFile(path.join(sourceDir, "CMakeUserPresets.json"), seen, loaded, errors);

  const configureByName = new Map<string, RawConfigurePreset>();
  const configureFile = new Map<string, string>();
  const buildByName = new Map<string, RawBuildPreset>();
  const buildFile = new Map<string, string>();
  for (const { file, data } of loaded) {
    for (const p of data.configurePresets ?? []) {
      configureByName.set(p.name, p);
      configureFile.set(p.name, file);
    }
    for (const p of data.buildPresets ?? []) {
      buildByName.set(p.name, p);
      buildFile.set(p.name, file);
    }
  }

  const configurePresets: ConfigurePreset[] = [];
  for (const preset of configureByName.values()) {
    if (preset.hidden) continue;
    const file = configureFile.get(preset.name)!;
    const generator = resolveInherited(preset, "generator", configureByName);
    const vars: Record<string, string> = {
      sourceDir,
      sourceParentDir: path.dirname(sourceDir),
      sourceDirName: path.basename(sourceDir),
      presetName: preset.name,
      generator: generator ?? "",
      hostSystemName: HOST_SYSTEM_NAME[os.platform()] ?? os.platform(),
      fileDir: path.dirname(file),
      dollar: "$",
      pathListSep: path.delimiter,
    };
    const rawBinaryDir = resolveInherited(preset, "binaryDir", configureByName);
    const toolchainFile = resolveInherited(preset, "toolchainFile", configureByName);
    configurePresets.push({
      name: preset.name,
      displayName: preset.displayName,
      description: preset.description,
      generator,
      binaryDir: rawBinaryDir ? path.resolve(sourceDir, expandMacros(rawBinaryDir, vars)) : undefined,
      toolchainFile: toolchainFile ? expandMacros(toolchainFile, vars) : undefined,
      cacheVariables: mergedCacheVariables(preset, configureByName),
      file,
    });
  }

  const buildPresets: BuildPreset[] = [];
  for (const preset of buildByName.values()) {
    if (preset.hidden) continue;
    buildPresets.push({
      name: preset.name,
      displayName: preset.displayName,
      configurePreset: resolveInherited(preset, "configurePreset", buildByName),
      configuration: resolveInherited(preset, "configuration", buildByName),
      targets: toList(resolveInherited(preset, "targets", buildByName)),
      file: buildFile.get(preset.name)!,
    });
  }

  return { files: loaded.map((l) => l.file), configurePresets, buildPresets, errors };
}
