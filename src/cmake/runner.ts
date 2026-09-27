import { spawn } from "node:child_process";

export interface RunResult {
  command: string[];
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  output: string;
}

const MAX_OUTPUT_CHARS = 200_000;

/** Runs a process capturing interleaved stdout/stderr, keeping only the tail if it is huge. */
export function run(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<RunResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const append = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > MAX_OUTPUT_CHARS * 2) output = output.slice(-MAX_OUTPUT_CHARS);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);
    const finish = (exitCode: number | null, signal: string | null) => {
      clearTimeout(timer);
      if (output.length > MAX_OUTPUT_CHARS) {
        output = `[... output truncated ...]\n${output.slice(-MAX_OUTPUT_CHARS)}`;
      }
      resolve({ command: [command, ...args], exitCode, signal, timedOut, durationMs: Date.now() - started, output });
    };
    child.on("error", (err) => {
      output += `\n${err.message}`;
      finish(null, null);
    });
    child.on("close", (code, signal) => finish(code, signal));
  });
}

/** Returns the last `maxLines` lines, which is where CMake puts errors and summaries. */
export function tail(text: string, maxLines: number): string {
  const lines = text.trimEnd().split("\n");
  if (lines.length <= maxLines) return lines.join("\n");
  return [`[... ${lines.length - maxLines} earlier lines omitted ...]`, ...lines.slice(-maxLines)].join("\n");
}
