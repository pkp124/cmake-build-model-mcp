import { promises as fs } from "node:fs";
import path from "node:path";
import { CtestError } from "./error.js";
import { XmlTokenizer, type XmlEvent } from "./xml.js";

export interface LocatedResults {
  file: string;
  tag?: string;
  track?: string;
}

export async function locateTestXml(buildDir: string, explicit?: string): Promise<LocatedResults> {
  if (explicit) {
    const file = path.resolve(explicit);
    try {
      await fs.access(file);
    } catch {
      throw new CtestError(`Test result file not found: ${file}`);
    }
    return { file };
  }
  const tagFile = path.join(buildDir, "Testing", "TAG");
  let text: string;
  try {
    text = await fs.readFile(tagFile, "utf8");
  } catch {
    throw new CtestError(
      `No CTest results in ${buildDir}. Run \`ctest -T Test\` there. A plain \`ctest\` run does not write Testing/<tag>/Test.xml.`,
    );
  }
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  const tag = lines[0];
  if (!tag) throw new CtestError(`${tagFile} is empty.`);
  const file = path.join(buildDir, "Testing", tag, "Test.xml");
  try {
    await fs.access(file);
  } catch {
    throw new CtestError(`${tagFile} points at ${file}, which is missing.`);
  }
  return { file, tag, track: lines[1] };
}

/** Names recorded in `Testing/Temporary/LastTestsFailed.log` (`index:name` per line). */
export async function readFailedNames(buildDir: string): Promise<string[]> {
  const file = path.join(buildDir, "Testing", "Temporary", "LastTestsFailed.log");
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    throw new CtestError(`No ${file}. Run ctest so it can record failures. Disabled tests are not listed there.`);
  }
  const names: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    names.push(colon >= 0 ? trimmed.slice(colon + 1) : trimmed);
  }
  return names;
}

export interface ResultEntry {
  name: string;
  status: string;
  path?: string;
  fullName?: string;
  time?: number;
  exitCode?: string;
  exitValue?: string;
  completionStatus?: string;
  labels: string[];
  offset: number;
}

export interface TestRunSummary {
  startDateTime?: string;
  startTestTime?: number;
  endDateTime?: string;
  endTestTime?: number;
  elapsedMinutes?: number;
  total: number;
  counts: Record<string, number>;
  site?: { buildName?: string; generator?: string; hostname?: string };
}

export interface TestResultDetails {
  name: string;
  status: string;
  path?: string;
  fullName?: string;
  fullCommandLine?: string;
  time?: number;
  exitCode?: string;
  exitValue?: string;
  completionStatus?: string;
  failReason?: string;
  passReason?: string;
  labels: string[];
  output: string;
  outputBytes: number;
  truncated?: boolean;
  measurements: { name: string; type?: string; value: string; truncated?: boolean }[];
  attachments?: { name?: string; filename?: string; encoding?: string; compression?: string; type?: string }[];
}

export class TestRun {
  private constructor(
    readonly file: string,
    readonly mtimeMs: number,
    readonly size: number,
    readonly tag: string | undefined,
    readonly track: string | undefined,
    readonly summary: TestRunSummary,
    readonly tests: ResultEntry[],
  ) {}

  static async load(located: LocatedResults, previous?: TestRun): Promise<TestRun> {
    const stat = await fs.stat(located.file);
    if (previous && previous.file === located.file && previous.mtimeMs === stat.mtimeMs && previous.size === stat.size) {
      return previous;
    }
    const indexed = await indexTestXml(located.file);
    return new TestRun(located.file, stat.mtimeMs, stat.size, located.tag, located.track, indexed.summary, indexed.tests);
  }

  /** Every result with this test name, in file order. */
  named(name: string): ResultEntry[] {
    return this.tests.filter((test) => test.name === name);
  }
}

export async function readTestResult(file: string, offset: number, maxOutputBytes: number): Promise<TestResultDetails> {
  const found = await walkTestXml(file, offset, { capture: true, maxOutputBytes, stopAfterTests: 1 });
  const details = found.details[0];
  if (!details) throw new CtestError(`No <Test> element at offset ${offset} in ${file}.`);
  return details;
}

async function indexTestXml(file: string): Promise<{ summary: TestRunSummary; tests: ResultEntry[] }> {
  const walked = await walkTestXml(file, 0, { capture: false, maxOutputBytes: 0, stopAfterTests: undefined });
  const counts: Record<string, number> = {};
  for (const test of walked.entries) counts[test.status || "unknown"] = (counts[test.status || "unknown"] ?? 0) + 1;
  return {
    summary: { ...walked.summary, total: walked.entries.length, counts },
    tests: walked.entries,
  };
}

interface WalkOptions {
  capture: boolean;
  maxOutputBytes: number;
  stopAfterTests: number | undefined;
}

interface Walked {
  summary: Omit<TestRunSummary, "total" | "counts">;
  entries: ResultEntry[];
  details: TestResultDetails[];
}

async function walkTestXml(file: string, start: number, options: WalkOptions): Promise<Walked> {
  const summary: Walked["summary"] = {};
  const entries: ResultEntry[] = [];
  const details: TestResultDetails[] = [];
  const stack: string[] = [];
  let text = "";
  let dropping = false;
  let test: Draft | undefined;
  let finished = 0;

  const take = () => {
    const value = text;
    text = "";
    return value;
  };

  await scanXml(file, start, (event) => {
    if (event.type === "text") {
      if (test?.inStdout) {
        test.outputBytes += Buffer.byteLength(event.text);
        if (options.capture) {
          const capped = cap(test.output, event.text, options.maxOutputBytes);
          test.output = capped.text;
          test.outputTruncated = test.outputTruncated || capped.truncated;
        }
        return;
      }
      if (!dropping && text.length < 256_000) text += event.text;
      return;
    }
    if (event.type === "start") {
      take();
      const parent = stack.at(-1);
      stack.push(event.name);
      if (event.name === "Site") {
        summary.site = {
          buildName: event.attrs.BuildName,
          generator: event.attrs.Generator,
          hostname: event.attrs.Hostname,
        };
      } else if (event.name === "Test") {
        test = emptyDraft(event.attrs.Status ?? "", event.offset);
      } else if (event.name === "NamedMeasurement" && test) {
        test.measurement = {
          name: event.attrs.name ?? "",
          type: event.attrs.type,
          filename: event.attrs.filename,
          encoding: event.attrs.encoding,
          compression: event.attrs.compression,
        };
        test.measurementIsFile =
          event.attrs.encoding === "base64" || event.attrs.type === "file" || Boolean(event.attrs.filename);
      } else if (event.name === "Value" && parent === "Measurement" && test) {
        test.inStdout = true;
      } else if (event.name === "Value" && parent === "NamedMeasurement" && test?.measurementIsFile) {
        dropping = true;
      }
      return;
    }

    const raw = take();
    const value = raw.trim();
    const parent = stack.at(-2);
    const name = event.name;
    if (test && name === "Value" && parent === "NamedMeasurement" && test.measurement && !test.measurementIsFile) {
      rememberMeasurement(test, value, options);
    } else if (test && name === "Value" && parent === "Measurement") {
      test.inStdout = false;
    } else if (name === "Value") {
      dropping = false;
    } else if (test && parent === "Test") {
      if (name === "Name") test.name = value;
      else if (name === "Path") test.path = value;
      else if (name === "FullName") test.fullName = value;
      else if (name === "FullCommandLine") test.fullCommandLine = value;
    } else if (test && name === "Label" && parent === "Labels") {
      if (value) test.labels.push(value);
    } else if (!test) {
      assignSummary(summary, name, value);
    }
    if (name === "NamedMeasurement") {
      if (test?.measurementIsFile && test.measurement) {
        test.attachments.push({
          name: test.measurement.name || undefined,
          filename: test.measurement.filename,
          encoding: test.measurement.encoding,
          compression: test.measurement.compression,
          type: test.measurement.type,
        });
      }
      if (test) {
        test.measurement = undefined;
        test.measurementIsFile = false;
      }
    }
    if (name === "Test" && test?.name) {
      entries.push(toEntry(test));
      if (options.capture) details.push(toDetails(test));
      test = undefined;
      finished++;
    }
    stack.pop();
    if (options.stopAfterTests !== undefined && finished >= options.stopAfterTests) return false;
  });

  return { summary, entries, details };
}

interface MeasurementDraft {
  name: string;
  type?: string;
  filename?: string;
  encoding?: string;
  compression?: string;
}

interface Draft {
  offset: number;
  status: string;
  name?: string;
  path?: string;
  fullName?: string;
  fullCommandLine?: string;
  time?: number;
  exitCode?: string;
  exitValue?: string;
  completionStatus?: string;
  failReason?: string;
  passReason?: string;
  labels: string[];
  output: string;
  outputBytes: number;
  outputTruncated: boolean;
  measurements: { name: string; type?: string; value: string; truncated?: boolean }[];
  attachments: NonNullable<TestResultDetails["attachments"]>;
  measurement?: MeasurementDraft;
  measurementIsFile: boolean;
  inStdout: boolean;
}

function emptyDraft(status: string, offset: number): Draft {
  return {
    offset,
    status,
    labels: [],
    output: "",
    outputBytes: 0,
    outputTruncated: false,
    measurements: [],
    attachments: [],
    measurementIsFile: false,
    inStdout: false,
  };
}

function rememberMeasurement(test: Draft, value: string, options: WalkOptions): void {
  const measurement = test.measurement;
  if (!measurement) return;
  if (measurement.name === "Execution Time") {
    const time = Number(value);
    if (Number.isFinite(time)) test.time = time;
  } else if (measurement.name === "Exit Code") test.exitCode = value;
  else if (measurement.name === "Exit Value") test.exitValue = value;
  else if (measurement.name === "Completion Status") test.completionStatus = value;
  else if (measurement.name === "Fail Reason") test.failReason = value;
  else if (measurement.name === "Pass Reason") test.passReason = value;
  if (!options.capture) return;
  const capped = cap("", value, options.maxOutputBytes);
  test.measurements.push({
    name: measurement.name,
    type: measurement.type,
    value: capped.text,
    truncated: capped.truncated || undefined,
  });
}

function assignSummary(summary: Walked["summary"], name: string, value: string): void {
  switch (name) {
    case "StartDateTime":
      summary.startDateTime = value;
      break;
    case "EndDateTime":
      summary.endDateTime = value;
      break;
    case "StartTestTime":
      summary.startTestTime = numberOrUndefined(value);
      break;
    case "EndTestTime":
      summary.endTestTime = numberOrUndefined(value);
      break;
    case "ElapsedMinutes":
      summary.elapsedMinutes = numberOrUndefined(value);
      break;
    default:
      break;
  }
}

function numberOrUndefined(value: string): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function toEntry(test: Draft): ResultEntry {
  return {
    name: test.name ?? "",
    status: test.status,
    path: test.path,
    fullName: test.fullName,
    time: test.time,
    exitCode: test.exitCode,
    exitValue: test.exitValue,
    completionStatus: test.completionStatus,
    labels: test.labels,
    offset: test.offset,
  };
}

function toDetails(test: Draft): TestResultDetails {
  return {
    name: test.name ?? "",
    status: test.status,
    path: test.path,
    fullName: test.fullName,
    fullCommandLine: test.fullCommandLine,
    time: test.time,
    exitCode: test.exitCode,
    exitValue: test.exitValue,
    completionStatus: test.completionStatus,
    failReason: test.failReason,
    passReason: test.passReason,
    labels: test.labels,
    output: test.output,
    outputBytes: test.outputBytes,
    truncated: test.outputTruncated || undefined,
    measurements: test.measurements,
    attachments: test.attachments.length ? test.attachments : undefined,
  };
}

function cap(current: string, extra: string, max: number): { text: string; truncated: boolean } {
  const used = Buffer.byteLength(current);
  if (used >= max) return { text: current, truncated: extra.length > 0 };
  const room = max - used;
  const extraBytes = Buffer.byteLength(extra);
  if (extraBytes <= room) return { text: current + extra, truncated: false };
  const sliced = Buffer.from(extra).subarray(0, room).toString("utf8").replace(/\uFFFD$/, "");
  return { text: current + sliced, truncated: true };
}

async function scanXml(file: string, start: number, onEvent: (event: XmlEvent) => boolean | void): Promise<void> {
  const handle = await fs.open(file, "r");
  try {
    const tokenizer = new XmlTokenizer(start);
    const buf = Buffer.alloc(64 * 1024);
    let position = start;
    let stop = false;
    const emit = (events: XmlEvent[]) => {
      if (stop) return;
      for (const event of events) {
        if (onEvent(event) === false) {
          stop = true;
          return;
        }
      }
    };
    while (!stop) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, position);
      if (bytesRead === 0) {
        emit(tokenizer.end());
        return;
      }
      position += bytesRead;
      emit(tokenizer.push(Buffer.from(buf.subarray(0, bytesRead))));
    }
  } finally {
    await handle.close();
  }
}
