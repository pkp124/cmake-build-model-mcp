import { CtestError } from "./error.js";

const compiled = new Map<string, RegExp>();

/**
 * Compiles a ctest / `string(REGEX)` pattern.
 * Matching is unanchored and case-sensitive. `{` and `}` are literal.
 * JavaScript-only features (`\d`, `\b`, lookaheads, lazy quantifiers) are rejected
 * so a pattern cannot silently mean something else than it does to ctest.
 */
export function ctestRegex(pattern: string): RegExp {
  const cached = compiled.get(pattern);
  if (cached) return cached;
  const regex = compileCTestRegex(pattern);
  compiled.set(pattern, regex);
  return regex;
}

function compileCTestRegex(pattern: string): RegExp {
  if (pattern.length === 0) throw new CtestError("Test regex is empty.");
  let translated = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "\\") {
      const next = pattern[i + 1];
      if (next === undefined) throw new CtestError(`Invalid test regex ${quote(pattern)}: trailing backslash.`);
      i++;
      if ("dDsSwWbBAZ".includes(next)) {
        throw new CtestError(
          `Invalid test regex ${quote(pattern)}: \\${next} is not special in ctest regular expressions ` +
            `(string(REGEX) / POSIX extended, not JavaScript).`,
        );
      }
      translated += `\\${next}`;
      continue;
    }
    if (char === "(" && pattern[i + 1] === "?") {
      throw new CtestError(
        `Invalid test regex ${quote(pattern)}: ctest does not support '(?' groups.`,
      );
    }
    if ((char === "*" || char === "+" || char === "?") && pattern[i + 1] === "?") {
      throw new CtestError(
        `Invalid test regex ${quote(pattern)}: ctest does not support lazy quantifiers.`,
      );
    }
    if (char === "{" || char === "}") translated += `\\${char}`;
    else translated += char;
  }
  try {
    return new RegExp(translated);
  } catch (err) {
    throw new CtestError(`Invalid test regex ${quote(pattern)}: ${(err as Error).message}`);
  }
}

function quote(pattern: string): string {
  return `'${pattern}'`;
}
