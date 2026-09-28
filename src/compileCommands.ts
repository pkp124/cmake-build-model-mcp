import { promises as fs } from "node:fs";
import path from "node:path";

/** An entry of a JSON compilation database as written by CMAKE_EXPORT_COMPILE_COMMANDS. */
interface RawEntry {
  directory: string;
  file: string;
  command?: string;
  arguments?: string[];
  output?: string;
}

export interface CompileCommand {
  file: string;
  directory: string;
  output?: string;
  arguments: string[];
  /** The command string exactly as written in compile_commands.json, when the entry used `command`. */
  command?: string;
}

export const COMPILE_COMMANDS_HINT =
  "compile_commands.json is written when the project is configured with -DCMAKE_EXPORT_COMPILE_COMMANDS=ON " +
  "(Makefile and Ninja generators only).";

export class CompileCommandsDb {
  private readonly byFile = new Map<string, CompileCommand[]>();

  private constructor(
    readonly file: string,
    readonly mtimeMs: number,
    readonly entries: CompileCommand[],
  ) {
    for (const entry of entries) {
      const list = this.byFile.get(entry.file) ?? [];
      list.push(entry);
      this.byFile.set(entry.file, list);
    }
  }

  static path(buildDir: string): string {
    return path.join(buildDir, "compile_commands.json");
  }

  static async load(buildDir: string, previous?: CompileCommandsDb): Promise<CompileCommandsDb | undefined> {
    const file = CompileCommandsDb.path(buildDir);
    let mtimeMs: number;
    try {
      mtimeMs = (await fs.stat(file)).mtimeMs;
    } catch {
      return undefined;
    }
    if (previous && previous.file === file && previous.mtimeMs === mtimeMs) return previous;
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as RawEntry[];
    return new CompileCommandsDb(file, mtimeMs, raw.map(normalizeEntry));
  }

  forFile(file: string): CompileCommand[] {
    return this.byFile.get(path.normalize(file)) ?? [];
  }
}

function normalizeEntry(raw: RawEntry): CompileCommand {
  const directory = path.normalize(raw.directory);
  return {
    file: path.resolve(directory, raw.file),
    directory,
    output: raw.output,
    arguments: raw.arguments ?? splitCommand(raw.command ?? ""),
    command: raw.arguments ? undefined : raw.command,
  };
}

/**
 * Whether an entry was produced for `target` (and `configuration`, for multi-config generators).
 * CMake places objects under `CMakeFiles/<target>.dir/[<config>/]`, which is the only link between
 * compilation database entries and targets. Entries without `output` cannot be attributed.
 */
export function entryMatches(entry: CompileCommand, target?: string, configuration?: string): boolean {
  if (!target && !configuration) return true;
  if (!entry.output) return true;
  const output = `/${entry.output.replace(/\\/g, "/")}`;
  if (target && !output.includes(`/CMakeFiles/${target}.dir/`)) return false;
  if (configuration && !output.includes(`.dir/${configuration}/`)) return false;
  return true;
}

export function splitCommand(command: string, platform: NodeJS.Platform = process.platform): string[] {
  return platform === "win32" ? splitWindowsCommand(command) : splitPosixCommand(command);
}

/** Splits using POSIX shell quoting rules, as CMake writes on Unix hosts. */
export function splitPosixCommand(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let inArg = false;
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote === "'") {
      if (c === "'") quote = undefined;
      else current += c;
    } else if (quote === '"') {
      if (c === '"') quote = undefined;
      else if (c === "\\" && i + 1 < command.length && '"\\$`'.includes(command[i + 1])) current += command[++i];
      else current += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      inArg = true;
    } else if (c === "\\" && i + 1 < command.length) {
      current += command[++i];
      inArg = true;
    } else if (/\s/.test(c)) {
      if (inArg) args.push(current);
      current = "";
      inArg = false;
    } else {
      current += c;
      inArg = true;
    }
  }
  if (inArg) args.push(current);
  return args;
}

/** Splits using the MSVC runtime (CommandLineToArgvW) rules, as CMake writes on Windows hosts. */
export function splitWindowsCommand(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let inArg = false;
  let inQuotes = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "\\") {
      let slashes = 0;
      while (command[i] === "\\") {
        slashes++;
        i++;
      }
      if (command[i] === '"') {
        current += "\\".repeat(Math.floor(slashes / 2));
        if (slashes % 2 === 1) current += '"';
        else inQuotes = !inQuotes;
      } else {
        current += "\\".repeat(slashes);
        i--;
      }
      inArg = true;
    } else if (c === '"') {
      inQuotes = !inQuotes;
      inArg = true;
    } else if (!inQuotes && /\s/.test(c)) {
      if (inArg) args.push(current);
      current = "";
      inArg = false;
    } else {
      current += c;
      inArg = true;
    }
  }
  if (inArg) args.push(current);
  return args;
}
