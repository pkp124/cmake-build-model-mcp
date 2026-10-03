import { promises as fs } from "node:fs";
import path from "node:path";
import { cmakeBool, parseCmakeCommands, propertyPairs, splitCmakeList, type CmakeCommand } from "./cmake.js";
import { CtestError } from "./error.js";
import { ctestRegex } from "./regex.js";

export interface BacktraceFrame {
  file: string;
  line: number;
  command?: string;
}

export type ConfigGate = { kind: "matches"; regex: string } | { kind: "else"; excluded: string[] };

export interface TestFixtures {
  setup: string[];
  required: string[];
  cleanup: string[];
}

export interface CTestTest {
  name: string;
  command: string[];
  workingDirectory: string;
  sourceDir: string;
  /** Directory of the CTestTestfile that defined the test. */
  testBuildDir: string;
  labels: string[];
  disabled: boolean;
  depends: string[];
  fixtures: TestFixtures;
  environment?: string[];
  timeout?: number;
  cost?: number;
  processors?: number;
  skipReturnCode?: number;
  passRegularExpression?: string[];
  failRegularExpression?: string[];
  skipRegularExpression?: string[];
  willFail?: boolean;
  runSerial?: boolean;
  resourceLock?: string[];
  requiredFiles?: string[];
  attachedFiles?: string[];
  attachedFilesOnFail?: string[];
  /** CONFIGURATIONS property, when the test file sets one. */
  configurations?: string[];
  gates: ConfigGate[];
  backtrace: BacktraceFrame[];
  /** Uppercase property names that are not lifted into fields above. */
  properties?: Record<string, string>;
}

interface FileStamp {
  file: string;
  mtimeMs: number;
  size: number;
}

export class TestIndex {
  private constructor(
    readonly buildDir: string,
    readonly sourceDir: string | undefined,
    readonly tests: CTestTest[],
    readonly warnings: string[],
    private readonly stamps: FileStamp[],
  ) {}

  static async load(buildDir: string, previous?: TestIndex): Promise<TestIndex | undefined> {
    const root = path.join(buildDir, "CTestTestfile.cmake");
    let rootStat: { mtimeMs: number; size: number };
    try {
      const stat = await fs.stat(root);
      rootStat = { mtimeMs: stat.mtimeMs, size: stat.size };
    } catch {
      return undefined;
    }
    if (previous && previous.buildDir === buildDir && (await stampsUnchanged(previous.stamps))) return previous;
    const warnings: string[] = [];
    const stamps: FileStamp[] = [];
    const header = headerOf(await fs.readFile(root, "utf8"));
    const tests = await readTree(root, warnings, stamps, new Set());
    return new TestIndex(buildDir, header.sourceDir, tests, warnings, stamps.length ? stamps : [{ file: root, ...rootStat }]);
  }

  get hasConfigGates(): boolean {
    return this.tests.some((test) => test.gates.length > 0 || (test.configurations?.length ?? 0) > 0);
  }

  testsFor(configuration: string | undefined): CTestTest[] {
    return this.tests.filter((test) => matchesConfiguration(test, configuration));
  }

  get(name: string, configuration: string | undefined): CTestTest {
    const visible = this.testsFor(configuration).filter((test) => test.name === name);
    if (visible.length === 1) return visible[0];
    const any = this.tests.filter((test) => test.name === name);
    if (visible.length > 1) {
      throw new CtestError(`Test '${name}' is defined more than once for this configuration.`);
    }
    if (any.length > 0) {
      throw new CtestError(
        configuration
          ? `Test '${name}' is not part of configuration '${configuration}'.`
          : `Test '${name}' is only defined for a specific configuration. Pass \`configuration\`.`,
      );
    }
    const needle = name.toLowerCase();
    const suggestions = [...new Set(this.tests.map((test) => test.name))]
      .filter((candidate) => candidate.toLowerCase().includes(needle))
      .slice(0, 8);
    const hint = suggestions.length
      ? ` Did you mean: ${suggestions.join(", ")}?`
      : " Use `list_tests` to see test names.";
    throw new CtestError(`Test '${name}' not found.${hint}`);
  }
}

async function stampsUnchanged(stamps: FileStamp[]): Promise<boolean> {
  if (!stamps.length) return false;
  for (const stamp of stamps) {
    try {
      const stat = await fs.stat(stamp.file);
      if (stat.mtimeMs !== stamp.mtimeMs || stat.size !== stamp.size) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export function matchesConfiguration(test: CTestTest, configuration: string | undefined): boolean {
  if (test.configurations?.length) {
    if (!configuration) return false;
    const wanted = configuration.toLowerCase();
    if (!test.configurations.some((item) => item.toLowerCase() === wanted)) return false;
  }
  if (!test.gates.length) return true;
  if (!configuration) return false;
  return test.gates.every((gate) => gateMatches(gate, configuration));
}

function gateMatches(gate: ConfigGate, configuration: string): boolean {
  switch (gate.kind) {
    case "matches":
      return ctestRegex(gate.regex).test(configuration);
    case "else":
      return gate.excluded.every((regex) => !ctestRegex(regex).test(configuration));
    default: {
      const neverGate: never = gate;
      return neverGate;
    }
  }
}

export function definedAt(test: CTestTest): string | undefined {
  const frame = test.backtrace.find((item) => item.command === "add_test") ?? test.backtrace.find((item) => item.command);
  if (!frame) return undefined;
  return `${frame.file}:${frame.line}${frame.command ? ` (${frame.command})` : ""}`;
}

interface MutableTest {
  name: string;
  command: string[];
  workingDirectory?: string;
  sourceDir: string;
  testBuildDir: string;
  ownLabels: string[];
  directoryLabels: string[];
  labels: string[];
  disabled: boolean;
  depends: string[];
  fixtures: TestFixtures;
  environment?: string[];
  timeout?: number;
  cost?: number;
  processors?: number;
  skipReturnCode?: number;
  passRegularExpression?: string[];
  failRegularExpression?: string[];
  skipRegularExpression?: string[];
  willFail?: boolean;
  runSerial?: boolean;
  resourceLock?: string[];
  requiredFiles?: string[];
  attachedFiles?: string[];
  attachedFilesOnFail?: string[];
  configurations?: string[];
  gates: ConfigGate[];
  gateKey: string;
  backtrace: BacktraceFrame[];
  properties: Record<string, string>;
}

interface IfFrame {
  unrecognized: boolean;
  arm: "then" | "else";
  conditions: string[];
  activeRegex?: string;
}

const KNOWN = new Set([
  "add_test",
  "set_tests_properties",
  "set_directory_properties",
  "subdirs",
  "if",
  "elseif",
  "else",
  "endif",
]);

async function readTree(file: string, warnings: string[], stamps: FileStamp[], seen: Set<string>): Promise<CTestTest[]> {
  let real = file;
  try {
    real = await fs.realpath(file);
  } catch {
    warnings.push(`Cannot read ${file}.`);
    return [];
  }
  if (seen.has(real)) {
    warnings.push(`Skipping repeated include of ${file}.`);
    return [];
  }
  seen.add(real);
  const stat = await fs.stat(real);
  stamps.push({ file: real, mtimeMs: stat.mtimeMs, size: stat.size });
  const content = await fs.readFile(real, "utf8");
  const header = headerOf(content);
  const testBuildDir = header.buildDir ?? path.dirname(real);
  const sourceDir = header.sourceDir ?? "";
  let commands: CmakeCommand[];
  try {
    commands = parseCmakeCommands(content);
  } catch (err) {
    throw new CtestError(`${file}: ${(err as Error).message}`);
  }
  const fileTests: MutableTest[] = [];
  const sequence: (MutableTest | CTestTest[])[] = [];
  const frames: IfFrame[] = [];
  let directoryLabels: string[] = [];
  const warned = new Set<string>();

  const warn = (message: string) => {
    if (warnings.length >= 20 || warnings.includes(message)) return;
    warnings.push(message);
  };

  for (const command of commands) {
    if (!KNOWN.has(command.name)) {
      if (!warned.has(command.name)) {
        warned.add(command.name);
        warn(`${file}:${command.line}: ignoring '${command.name}' (only generated CTestTestfile commands are read).`);
      }
      continue;
    }
    switch (command.name) {
      case "if":
        frames.push(openIf(command, file, warn));
        break;
      case "elseif":
        replaceArm(frames, command, file, warn);
        break;
      case "else":
        setElse(frames, file, command.line, warn);
        break;
      case "endif":
        if (!frames.pop()) warn(`${file}:${command.line}: endif() without if().`);
        break;
      case "subdirs":
        for (const dir of command.args) {
          // subdirs() paths are relative to this file, not the "# Build directory:" header.
          const child = path.resolve(path.dirname(real), dir, "CTestTestfile.cmake");
          try {
            await fs.access(child);
          } catch {
            warn(`${file}:${command.line}: subdirs(${dir}) has no CTestTestfile.cmake.`);
            continue;
          }
          sequence.push(await readTree(child, warnings, stamps, seen));
        }
        break;
      case "add_test": {
        const added = parseAddTest(command);
        if (!added) {
          warn(`${file}:${command.line}: could not read add_test().`);
          break;
        }
        const gates = currentGates(frames);
        const created: MutableTest = {
          name: added.name,
          command: added.command,
          sourceDir,
          testBuildDir,
          ownLabels: [],
          directoryLabels: [],
          labels: [],
          disabled: false,
          depends: [],
          fixtures: { setup: [], required: [], cleanup: [] },
          gates,
          gateKey: JSON.stringify(gates),
          backtrace: [],
          properties: {},
        };
        sequence.push(created);
        fileTests.push(created);
        break;
      }
      case "set_tests_properties":
        applyTestProperties(fileTests, command, currentGates(frames), file, warn);
        break;
      case "set_directory_properties": {
        try {
          const props = propertiesAfterKeyword(command);
          if (props?.LABELS !== undefined) directoryLabels = listValue(props.LABELS);
        } catch (err) {
          warn(`${file}: ${(err as Error).message}`);
        }
        break;
      }
      default:
        warn(`${file}:${command.line}: unhandled command '${command.name}'.`);
    }
  }
  if (frames.length) warn(`${file}: unclosed if().`);
  const tests: CTestTest[] = [];
  for (const item of sequence) {
    if (Array.isArray(item)) {
      tests.push(...item);
      continue;
    }
    item.directoryLabels = directoryLabels;
    item.labels = mergeLabels(directoryLabels, item.ownLabels);
    if (!item.workingDirectory) item.workingDirectory = testBuildDir;
    tests.push(freeze(item));
  }
  return tests;
}

function freeze(test: MutableTest): CTestTest {
  const properties = Object.keys(test.properties).length ? test.properties : undefined;
  return {
    name: test.name,
    command: test.command,
    workingDirectory: test.workingDirectory ?? test.testBuildDir,
    sourceDir: test.sourceDir,
    testBuildDir: test.testBuildDir,
    labels: test.labels,
    disabled: test.disabled,
    depends: test.depends,
    fixtures: test.fixtures,
    environment: test.environment,
    timeout: test.timeout,
    cost: test.cost,
    processors: test.processors,
    skipReturnCode: test.skipReturnCode,
    passRegularExpression: test.passRegularExpression,
    failRegularExpression: test.failRegularExpression,
    skipRegularExpression: test.skipRegularExpression,
    willFail: test.willFail,
    runSerial: test.runSerial,
    resourceLock: test.resourceLock,
    requiredFiles: test.requiredFiles,
    attachedFiles: test.attachedFiles,
    attachedFilesOnFail: test.attachedFilesOnFail,
    configurations: test.configurations,
    gates: test.gates,
    backtrace: test.backtrace,
    properties,
  };
}

function headerOf(content: string): { sourceDir?: string; buildDir?: string } {
  return {
    sourceDir: /^# Source directory: (.*)$/m.exec(content)?.[1]?.trim(),
    buildDir: /^# Build directory: (.*)$/m.exec(content)?.[1]?.trim(),
  };
}

function openIf(command: CmakeCommand, file: string, warn: (message: string) => void): IfFrame {
  const regex = configurationRegex(command.args);
  if (regex === undefined) {
    warn(`${file}:${command.line}: if() is not a CTEST_CONFIGURATION_TYPE match; tests inside it are included for every configuration.`);
    return { unrecognized: true, arm: "then", conditions: [] };
  }
  return { unrecognized: false, arm: "then", conditions: [regex], activeRegex: regex };
}

function replaceArm(frames: IfFrame[], command: CmakeCommand, file: string, warn: (message: string) => void): void {
  const frame = frames[frames.length - 1];
  if (!frame) {
    warn(`${file}:${command.line}: elseif() without if().`);
    return;
  }
  const regex = configurationRegex(command.args);
  if (regex === undefined) {
    frame.unrecognized = true;
    frame.arm = "then";
    frame.activeRegex = undefined;
    warn(`${file}:${command.line}: elseif() is not a CTEST_CONFIGURATION_TYPE match.`);
    return;
  }
  frame.unrecognized = false;
  frame.arm = "then";
  frame.conditions.push(regex);
  frame.activeRegex = regex;
}

function setElse(frames: IfFrame[], file: string, line: number, warn: (message: string) => void): void {
  const frame = frames[frames.length - 1];
  if (!frame) {
    warn(`${file}:${line}: else() without if().`);
    return;
  }
  frame.arm = "else";
  frame.activeRegex = undefined;
}

function configurationRegex(args: string[]): string | undefined {
  if (args.length === 3 && args[0] === "CTEST_CONFIGURATION_TYPE" && args[1].toUpperCase() === "MATCHES") return args[2];
  return undefined;
}

function currentGates(frames: IfFrame[]): ConfigGate[] {
  const gates: ConfigGate[] = [];
  for (const frame of frames) {
    if (frame.unrecognized) continue;
    if (frame.arm === "else") gates.push({ kind: "else", excluded: [...frame.conditions] });
    else if (frame.activeRegex) gates.push({ kind: "matches", regex: frame.activeRegex });
  }
  return gates;
}

function parseAddTest(command: CmakeCommand): { name: string; command: string[] } | undefined {
  const args = command.args;
  if (!args.length) return undefined;
  const upper = args.map((arg) => arg.toUpperCase());
  if (upper[0] === "NAME" && upper.includes("COMMAND")) {
    const name = args[1];
    if (!name) return undefined;
    const commandAt = upper.indexOf("COMMAND");
    const stop = new Set(["CONFIGURATIONS", "WORKING_DIRECTORY", "COMMAND_EXPAND_LISTS"]);
    const argv: string[] = [];
    for (let i = commandAt + 1; i < args.length; i++) {
      if (stop.has(upper[i])) break;
      argv.push(args[i]);
    }
    return { name, command: argv };
  }
  return { name: args[0], command: args.slice(1) };
}

function applyTestProperties(
  tests: MutableTest[],
  command: CmakeCommand,
  gates: ConfigGate[],
  file: string,
  warn: (message: string) => void,
): void {
  const at = command.args.findIndex((arg) => arg.toUpperCase() === "PROPERTIES");
  if (at < 0) {
    warn(`${file}:${command.line}: set_tests_properties() without PROPERTIES.`);
    return;
  }
  const names = command.args.slice(0, at);
  let props: Record<string, string>;
  try {
    props = propertyPairs(command.args.slice(at + 1), command.line);
  } catch (err) {
    warn(`${file}: ${(err as Error).message}`);
    return;
  }
  const gateKey = JSON.stringify(gates);
  for (const name of names) {
    const targets = tests.filter((test) => test.name === name && test.gateKey === gateKey);
    if (!targets.length) {
      warn(`${file}:${command.line}: no test named '${name}' for set_tests_properties().`);
      continue;
    }
    for (const test of targets) assignProperties(test, props);
  }
}

function assignProperties(test: MutableTest, props: Record<string, string>): void {
  for (const [key, value] of Object.entries(props)) {
    switch (key) {
      case "LABELS":
        test.ownLabels = listValue(value);
        break;
      case "DEPENDS":
        test.depends = listValue(value);
        break;
      case "FIXTURES_SETUP":
        test.fixtures.setup = listValue(value);
        break;
      case "FIXTURES_REQUIRED":
        test.fixtures.required = listValue(value);
        break;
      case "FIXTURES_CLEANUP":
        test.fixtures.cleanup = listValue(value);
        break;
      case "WORKING_DIRECTORY":
        test.workingDirectory = value;
        break;
      case "ENVIRONMENT":
        test.environment = listValue(value);
        break;
      case "TIMEOUT":
        test.timeout = numberOrRaw(test, key, value);
        break;
      case "COST":
        test.cost = numberOrRaw(test, key, value);
        break;
      case "PROCESSORS":
        test.processors = numberOrRaw(test, key, value);
        break;
      case "SKIP_RETURN_CODE":
        test.skipReturnCode = numberOrRaw(test, key, value);
        break;
      case "PASS_REGULAR_EXPRESSION":
        test.passRegularExpression = listValue(value);
        break;
      case "FAIL_REGULAR_EXPRESSION":
        test.failRegularExpression = listValue(value);
        break;
      case "SKIP_REGULAR_EXPRESSION":
        test.skipRegularExpression = listValue(value);
        break;
      case "WILL_FAIL":
        test.willFail = boolOrRaw(test, key, value);
        break;
      case "RUN_SERIAL":
        test.runSerial = boolOrRaw(test, key, value);
        break;
      case "DISABLED":
        test.disabled = boolOrRaw(test, key, value) ?? false;
        break;
      case "RESOURCE_LOCK":
        test.resourceLock = listValue(value);
        break;
      case "REQUIRED_FILES":
        test.requiredFiles = listValue(value);
        break;
      case "ATTACHED_FILES":
        test.attachedFiles = listValue(value);
        break;
      case "ATTACHED_FILES_ON_FAIL":
        test.attachedFilesOnFail = listValue(value);
        break;
      case "CONFIGURATIONS":
        test.configurations = listValue(value);
        break;
      case "_BACKTRACE_TRIPLES":
        test.backtrace = parseBacktrace(value);
        break;
      default:
        test.properties[key] = value;
    }
  }
}

function listValue(value: string): string[] {
  return splitCmakeList(value).filter((item) => item.length > 0);
}

function numberOrRaw(test: MutableTest, key: string, value: string): number | undefined {
  const number = Number(value);
  if (value.trim() !== "" && Number.isFinite(number)) return number;
  test.properties[key] = value;
  return undefined;
}

function boolOrRaw(test: MutableTest, key: string, value: string): boolean | undefined {
  const parsed = cmakeBool(value);
  if (parsed !== undefined) return parsed;
  test.properties[key] = value;
  return undefined;
}

function parseBacktrace(value: string): BacktraceFrame[] {
  const parts = splitCmakeList(value);
  const frames: BacktraceFrame[] = [];
  for (let i = 0; i + 2 < parts.length; i += 3) {
    const command = parts[i + 2];
    const line = Number(parts[i + 1]);
    if (!command && (!Number.isFinite(line) || line === 0)) continue;
    frames.push({
      file: parts[i],
      line: Number.isFinite(line) ? line : 0,
      command: command || undefined,
    });
  }
  return frames;
}

function propertiesAfterKeyword(command: CmakeCommand): Record<string, string> | undefined {
  const at = command.args.findIndex((arg) => arg.toUpperCase() === "PROPERTIES");
  if (at < 0) return undefined;
  return propertyPairs(command.args.slice(at + 1), command.line);
}

function mergeLabels(directory: string[], own: string[]): string[] {
  const labels: string[] = [];
  for (const label of [...directory, ...own]) {
    if (!labels.includes(label)) labels.push(label);
  }
  return labels;
}
