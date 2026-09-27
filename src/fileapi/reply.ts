import { promises as fs } from "node:fs";
import path from "node:path";
import type { Cache, CmakeFiles, Codemodel, ReplyIndex, Target, Toolchains } from "./types.js";

export const CLIENT_NAME = "client-cmake-build-model-mcp";

export const QUERY_REQUESTS = [
  { kind: "codemodel", version: 2 },
  { kind: "cache", version: 2 },
  { kind: "cmakeFiles", version: 1 },
  { kind: "toolchains", version: 1 },
] as const;

export function apiDir(buildDir: string): string {
  return path.join(buildDir, ".cmake", "api", "v1");
}

export function replyDir(buildDir: string): string {
  return path.join(apiDir(buildDir), "reply");
}

export function queryFile(buildDir: string): string {
  return path.join(apiDir(buildDir), "query", CLIENT_NAME, "query.json");
}

/** Writes a stateful client query so the next configure step generates the objects we need. */
export async function writeQuery(buildDir: string): Promise<boolean> {
  const file = queryFile(buildDir);
  const contents = JSON.stringify({ requests: QUERY_REQUESTS }, null, 2) + "\n";
  try {
    if ((await fs.readFile(file, "utf8")) === contents) return false;
  } catch {
    // Missing query file; fall through and create it.
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
  return true;
}

export async function hasQuery(buildDir: string): Promise<boolean> {
  try {
    await fs.access(queryFile(buildDir));
    return true;
  } catch {
    return false;
  }
}

export interface ReplyIndexInfo {
  file: string;
  mtimeMs: number;
}

/** Finds the newest `index-*.json`; names sort lexicographically by generation time. */
export async function findLatestReplyIndex(buildDir: string): Promise<ReplyIndexInfo | undefined> {
  let names: string[];
  try {
    names = await fs.readdir(replyDir(buildDir));
  } catch {
    return undefined;
  }
  const latest = names.filter((n) => n.startsWith("index-") && n.endsWith(".json")).sort().pop();
  if (!latest) return undefined;
  const file = path.join(replyDir(buildDir), latest);
  const stat = await fs.stat(file);
  return { file, mtimeMs: stat.mtimeMs };
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, "utf8")) as T;
}

type ObjectKinds = {
  codemodel: Codemodel;
  cache: Cache;
  cmakeFiles: CmakeFiles;
  toolchains: Toolchains;
};

/**
 * A parsed reply for a single build directory. Objects are loaded lazily and memoized, so
 * callers can hold on to one instance for as long as the reply index file does not change.
 */
export class Reply {
  private readonly objectCache = new Map<string, Promise<unknown>>();

  private constructor(
    readonly buildDir: string,
    readonly indexFile: string,
    readonly indexMtimeMs: number,
    readonly index: ReplyIndex,
  ) {}

  static async load(buildDir: string, info: ReplyIndexInfo): Promise<Reply> {
    return new Reply(buildDir, info.file, info.mtimeMs, await readJson<ReplyIndex>(info.file));
  }

  /** Available object kinds, including ones requested by other clients (IDEs, etc). */
  get availableKinds(): string[] {
    return this.index.objects.map((o) => `${o.kind}-v${o.version.major}.${o.version.minor}`);
  }

  async object<K extends keyof ObjectKinds>(kind: K): Promise<ObjectKinds[K] | undefined> {
    const ref = this.index.objects
      .filter((o) => o.kind === kind)
      .sort((a, b) => b.version.major - a.version.major || b.version.minor - a.version.minor)[0];
    if (!ref) return undefined;
    return (await this.jsonFile(ref.jsonFile)) as ObjectKinds[K];
  }

  async target(jsonFile: string): Promise<Target> {
    return (await this.jsonFile(jsonFile)) as Target;
  }

  private jsonFile(name: string): Promise<unknown> {
    let pending = this.objectCache.get(name);
    if (!pending) {
      pending = readJson(path.join(replyDir(this.buildDir), name));
      pending.catch(() => this.objectCache.delete(name));
      this.objectCache.set(name, pending);
    }
    return pending;
  }
}
