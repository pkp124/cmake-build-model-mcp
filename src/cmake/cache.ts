import { promises as fs } from "node:fs";

export interface CacheTxtEntry {
  name: string;
  type: string;
  value: string;
}

/** Minimal CMakeCache.txt parser, used before any File API reply exists. */
export function parseCMakeCacheTxt(text: string): Map<string, CacheTxtEntry> {
  const entries = new Map<string, CacheTxtEntry>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    // NAME:TYPE=VALUE, where NAME may be quoted.
    const match = /^("(?:[^"]*)"|[^:=]+)(?::([^=]*))?=(.*)$/.exec(line);
    if (!match) continue;
    const name = match[1].replace(/^"|"$/g, "");
    entries.set(name, { name, type: match[2] ?? "UNINITIALIZED", value: match[3] });
  }
  return entries;
}

export async function readCMakeCacheTxt(file: string): Promise<Map<string, CacheTxtEntry> | undefined> {
  try {
    return parseCMakeCacheTxt(await fs.readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}
