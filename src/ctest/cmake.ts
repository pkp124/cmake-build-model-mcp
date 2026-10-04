import { CtestError } from "./error.js";

export interface CmakeCommand {
  /** Command name, lowercased. */
  name: string;
  args: string[];
  line: number;
}

/**
 * Unescapes the body of a double-quoted CMake argument.
 * `\\` becomes `\`, `\;` becomes a literal semicolon, `\"` becomes `"`.
 */
export function unescapeCmakeQuoted(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\" && i + 1 < body.length) {
      const next = body[i + 1];
      if (next === "n") out += "\n";
      else if (next === "t") out += "\t";
      else if (next === "r") out += "\r";
      else out += next;
      i++;
    } else {
      out += body[i];
    }
  }
  return out;
}

/** Splits a CMake list. Semicolons preceded by an odd number of backslashes stay in the element. */
export function splitCmakeList(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let backslashes = 0;
  for (const char of value) {
    if (char === "\\") {
      backslashes++;
      current += char;
      continue;
    }
    if (char === ";" && backslashes % 2 === 0) {
      parts.push(unescapeListItem(current));
      current = "";
    } else {
      current += char;
    }
    backslashes = 0;
  }
  parts.push(unescapeListItem(current));
  return parts;
}

function unescapeListItem(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "\\" && i + 1 < value.length) {
      out += value[i + 1];
      i++;
    } else {
      out += value[i];
    }
  }
  return out;
}

export function cmakeBool(value: string): boolean | undefined {
  const upper = value.toUpperCase();
  if (upper === "1" || upper === "ON" || upper === "YES" || upper === "TRUE" || upper === "Y") return true;
  if (
    upper === "0" ||
    upper === "OFF" ||
    upper === "NO" ||
    upper === "FALSE" ||
    upper === "N" ||
    upper === "IGNORE" ||
    upper === "NOTFOUND" ||
    upper === "" ||
    upper.endsWith("-NOTFOUND")
  ) {
    return false;
  }
  return undefined;
}

/**
 * Splits a generated CTestTestfile into commands.
 * Understands quoted arguments, bracket arguments, escapes, and `#` comments.
 * Parentheses inside quotes or brackets do not end the command.
 */
export function parseCmakeCommands(content: string): CmakeCommand[] {
  const commands: CmakeCommand[] = [];
  let i = 0;
  let line = 1;

  const bump = (char: string) => {
    if (char === "\n") line++;
  };

  const skipTrivia = () => {
    while (i < content.length) {
      const char = content[i];
      if (char === " " || char === "\t" || char === "\r" || char === "\n") {
        bump(char);
        i++;
        continue;
      }
      if (char === "#") {
        skipComment();
        continue;
      }
      break;
    }
  };

  const skipComment = () => {
    if (content[i] !== "#") return;
    if (content[i + 1] === "[") {
      i++;
      readBracket();
      return;
    }
    while (i < content.length && content[i] !== "\n") i++;
  };

  const readQuoted = (): string => {
    let body = "";
    while (i < content.length) {
      const char = content[i];
      if (char === "\\" && i + 1 < content.length) {
        body += char + content[i + 1];
        bump(content[i + 1]);
        i += 2;
        continue;
      }
      if (char === '"') {
        i++;
        return unescapeCmakeQuoted(body);
      }
      bump(char);
      body += char;
      i++;
    }
    throw new CtestError(`Unterminated quoted argument at line ${line}.`);
  };

  const readBracket = (): string => {
    if (content[i] !== "[") throw new CtestError(`Expected a bracket argument at line ${line}.`);
    i++;
    let equals = 0;
    while (content[i] === "=") {
      equals++;
      i++;
    }
    if (content[i] !== "[") throw new CtestError(`Invalid bracket argument at line ${line}.`);
    i++;
    const close = `]${"=".repeat(equals)}]`;
    const end = content.indexOf(close, i);
    if (end < 0) throw new CtestError(`Unterminated bracket argument at line ${line}.`);
    const body = content.slice(i, end);
    for (const char of body) bump(char);
    i = end + close.length;
    return body;
  };

  const readUnquoted = (): string => {
    let body = "";
    while (i < content.length) {
      const char = content[i];
      if (char === "\\" && i + 1 < content.length) {
        body += content[i + 1];
        bump(content[i + 1]);
        i += 2;
        continue;
      }
      if (char === " " || char === "\t" || char === "\r" || char === "\n" || char === "(" || char === ")" || char === '"' || char === "#" || char === "[") {
        break;
      }
      bump(char);
      body += char;
      i++;
    }
    return body;
  };

  while (i < content.length) {
    skipTrivia();
    if (i >= content.length) break;
    const startLine = line;
    if (!/[A-Za-z_]/.test(content[i])) {
      throw new CtestError(`Expected a CMake command at line ${line}.`);
    }
    const nameStart = i;
    i++;
    while (i < content.length && /[A-Za-z0-9_]/.test(content[i])) i++;
    const name = content.slice(nameStart, i).toLowerCase();
    skipTrivia();
    if (content[i] !== "(") throw new CtestError(`Expected '(' after ${name} at line ${line}.`);
    i++;
    let depth = 1;
    const args: string[] = [];
    while (i < content.length && depth > 0) {
      skipTrivia();
      if (i >= content.length) break;
      const char = content[i];
      if (char === "(") {
        depth++;
        i++;
        continue;
      }
      if (char === ")") {
        depth--;
        i++;
        continue;
      }
      if (depth === 0) break;
      if (char === '"') {
        i++;
        args.push(readQuoted());
        continue;
      }
      if (char === "[") {
        args.push(readBracket());
        continue;
      }
      const arg = readUnquoted();
      if (arg.length > 0) args.push(arg);
    }
    if (depth !== 0) throw new CtestError(`Unterminated ${name}( starting at line ${startLine}.`);
    commands.push({ name, args, line: startLine });
  }
  return commands;
}

/** Parses `KEY value KEY value` pairs. Keys are uppercased. */
export function propertyPairs(args: string[], line: number): Record<string, string> {
  const props: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (value === undefined) {
      throw new CtestError(`Property ${key} at line ${line} has no value.`);
    }
    props[key.toUpperCase()] = value;
  }
  return props;
}
