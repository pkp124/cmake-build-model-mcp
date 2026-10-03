import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { CtestError } from "./error.js";
import type { TestSelector } from "./select.js";
import type { TestFixtures } from "./testfile.js";

const execFileAsync = promisify(execFile);

export interface ShownTest {
  name: string;
  command?: string[];
  workingDirectory?: string;
  disabled: boolean;
  labels: string[];
  fixtures: TestFixtures;
}

interface ShowFile {
  tests?: ShowTestJson[];
}

interface ShowTestJson {
  name: string;
  command?: string[];
  properties?: { name: string; value: unknown }[];
}

let helpText: Promise<string> | undefined;

/**
 * Runs `ctest --show-only=json-v1`. This does not execute tests.
 * ctest updates `Testing/Temporary/LastTest.log` in the build directory.
 */
export async function showOnly(
  buildDir: string,
  selector: TestSelector,
  configuration: string | undefined,
): Promise<ShownTest[]> {
  const help = await ctestHelp();
  const args = ["--show-only=json-v1", "--test-dir", buildDir];
  if (configuration) args.push("-C", configuration);
  const tmp = await mkdtemp(path.join(os.tmpdir(), "ctest-mcp-"));
  try {
    if (selector.failedNames) {
      args.push("--rerun-failed");
    } else {
      if (selector.include) args.push("-R", selector.include);
      if (selector.exclude) args.push("-E", selector.exclude);
      for (const label of selector.labels ?? []) args.push("-L", label);
      for (const label of selector.excludeLabels ?? []) args.push("-LE", label);
      if (selector.fixtureExcludeAny) args.push("-FA", selector.fixtureExcludeAny);
      if (selector.fixtureExcludeSetup) args.push("-FS", selector.fixtureExcludeSetup);
      if (selector.fixtureExcludeCleanup) args.push("-FC", selector.fixtureExcludeCleanup);
      if (selector.names?.length) {
        args.push("--tests-from-file", await nameFile(tmp, "include.txt", selector.names, help, "--tests-from-file"));
      }
      if (selector.excludeNames?.length) {
        args.push(
          "--exclude-from-file",
          await nameFile(tmp, "exclude.txt", selector.excludeNames, help, "--exclude-from-file"),
        );
      }
    }
    const stdout = await runCtest(buildDir, args);
    const compileError = stdout.split("\n").filter((line) => line.startsWith("RegularExpression::compile():"));
    if (compileError.length) throw new CtestError(compileError.join("\n"));
    const jsonAt = stdout.indexOf("{");
    if (jsonAt < 0) throw new CtestError(`ctest --show-only did not return JSON.\n${stdout.slice(0, 400)}`);
    let parsed: ShowFile;
    try {
      parsed = JSON.parse(stdout.slice(jsonAt)) as ShowFile;
    } catch (err) {
      throw new CtestError(`Could not parse ctest JSON: ${(err as Error).message}`);
    }
    return (parsed.tests ?? []).map(toShown);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function nameFile(dir: string, filename: string, names: string[], help: string, flag: string): Promise<string> {
  if (!help.includes(flag)) {
    throw new CtestError(
      `This ctest does not support ${flag} (it needs CMake 3.29 or newer). Use engine "index" for an exact name list.`,
    );
  }
  const file = path.join(dir, filename);
  await writeFile(file, `${names.join("\n")}\n`);
  return file;
}

async function runCtest(buildDir: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync("ctest", args, {
      cwd: buildDir,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
    });
    return result.stdout;
  } catch (err) {
    const error = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean };
    if (error.code === "ENOENT") {
      throw new CtestError('ctest was not found on PATH. Use engine "index", or install CMake.');
    }
    if (error.killed) throw new CtestError('ctest --show-only timed out. Use engine "index".');
    const stdout = error.stdout ?? "";
    if (stdout.includes("{") || stdout.includes("RegularExpression::compile():")) return stdout;
    throw new CtestError(`ctest --show-only failed.\n${error.stderr || error.message}`);
  }
}

function ctestHelp(): Promise<string> {
  if (!helpText) {
    helpText = execFileAsync("ctest", ["--help"], { maxBuffer: 1024 * 1024 })
      .then((result) => result.stdout)
      .catch((err: NodeJS.ErrnoException) => {
        helpText = undefined;
        if (err.code === "ENOENT") {
          throw new CtestError('ctest was not found on PATH. Use engine "index", or install CMake.');
        }
        throw new CtestError(`Could not run ctest --help: ${err.message}`);
      });
  }
  return helpText;
}

function toShown(test: ShowTestJson): ShownTest {
  const disabled = property(test, "DISABLED");
  const workingDirectory = property(test, "WORKING_DIRECTORY");
  return {
    name: test.name,
    command: test.command,
    workingDirectory: typeof workingDirectory === "string" ? workingDirectory : undefined,
    disabled: disabled === true,
    labels: stringList(property(test, "LABELS")),
    fixtures: {
      setup: stringList(property(test, "FIXTURES_SETUP")),
      required: stringList(property(test, "FIXTURES_REQUIRED")),
      cleanup: stringList(property(test, "FIXTURES_CLEANUP")),
    },
  };
}

function property(test: ShowTestJson, name: string): unknown {
  return test.properties?.find((entry) => entry.name === name)?.value;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string" && value.length > 0) return [value];
  return [];
}
