/** Streaming XML tokenizer for CTest `Test.xml`. Offsets are byte offsets. */

export type XmlEvent =
  | { type: "start"; name: string; attrs: Record<string, string>; offset: number }
  | { type: "end"; name: string; offset: number }
  | { type: "text"; text: string };

export function tokenizeBuffers(chunks: Buffer[]): XmlEvent[] {
  const tokenizer = new XmlTokenizer(0);
  const events: XmlEvent[] = [];
  for (const chunk of chunks) events.push(...tokenizer.push(chunk));
  events.push(...tokenizer.end());
  return events;
}

export class XmlTokenizer {
  private pending: Buffer = Buffer.alloc(0);
  /** File offset of `pending[0]`. */
  private base: number;

  constructor(startOffset: number) {
    this.base = startOffset;
  }

  push(chunk: Buffer): XmlEvent[] {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    return this.drain(false);
  }

  end(): XmlEvent[] {
    return this.drain(true);
  }

  private drain(eof: boolean): XmlEvent[] {
    const events: XmlEvent[] = [];
    while (this.pending.length > 0) {
      if (this.pending[0] !== 0x3c) {
        const lt = this.pending.indexOf(0x3c);
        if (lt === 0) continue;
        if (lt > 0) {
          events.push({ type: "text", text: decodeXml(this.pending.subarray(0, lt).toString("utf8")) });
          this.consume(lt);
          continue;
        }
        const cut = textCut(this.pending, eof);
        if (cut <= 0) break;
        events.push({ type: "text", text: decodeXml(this.pending.subarray(0, cut).toString("utf8")) });
        this.consume(cut);
        continue;
      }

      const markup = markupSpan(this.pending);
      if (!markup) {
        if (eof) break;
        break;
      }
      const raw = this.pending.subarray(0, markup.end);
      const offset = this.base;
      this.consume(markup.end);
      if (markup.kind === "cdata") {
        const body = raw.subarray("<![CDATA[".length, raw.length - "]]>".length);
        events.push({ type: "text", text: body.toString("utf8") });
        continue;
      }
      if (markup.kind === "tag") events.push(...parseTag(raw.toString("utf8"), offset));
    }
    return events;
  }

  private consume(bytes: number): void {
    this.pending = this.pending.subarray(bytes);
    this.base += bytes;
  }
}

type Markup =
  | { kind: "tag" | "cdata"; end: number }
  | { kind: "skip"; end: number };

/** Returns the end (exclusive) of the markup starting at byte 0, or undefined if the token is incomplete. */
function markupSpan(buf: Buffer): Markup | undefined {
  if (buf.length < 2) return undefined;
  if (buf.length >= 4 && buf.subarray(0, 4).toString("utf8") === "<!--") return closed(buf, "-->", "skip");
  if (buf.length >= 9 && buf.subarray(0, 9).toString("utf8") === "<![CDATA[") return closed(buf, "]]>", "cdata");
  if (buf[1] === 0x3f) return closed(buf, "?>", "skip");
  if (buf[1] === 0x21) {
    const soFar = buf.toString("utf8");
    if ("<!--".startsWith(soFar) || "<![CDATA[".startsWith(soFar)) return undefined;
    return closed(buf, ">", "skip");
  }
  const end = buf.indexOf(0x3e);
  if (end < 0) return undefined;
  return { kind: "tag", end: end + 1 };
}

function closed(buf: Buffer, needle: string, kind: Markup["kind"]): Markup | undefined {
  const at = buf.indexOf(needle);
  if (at < 0) return undefined;
  return { kind, end: at + needle.length };
}

function parseTag(text: string, offset: number): XmlEvent[] {
  const empty = text.endsWith("/>");
  const body = text.slice(1, empty ? -2 : -1).trim();
  if (body.startsWith("/")) {
    const name = body.slice(1).trim().split(/\s+/, 1)[0] ?? "";
    return [{ type: "end", name, offset }];
  }
  const name = /^[A-Za-z_:][\w:.-]*/.exec(body)?.[0] ?? "";
  const start: XmlEvent = { type: "start", name, attrs: parseAttrs(body.slice(name.length)), offset };
  return empty ? [start, { type: "end", name, offset }] : [start];
}

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of source.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    attrs[match[1]] = decodeXml(match[3] ?? match[4] ?? "");
  }
  return attrs;
}

export function decodeXml(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (all, ent: string) => {
    switch (ent) {
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "amp":
        return "&";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default: {
        const code = ent.startsWith("#x") ? Number.parseInt(ent.slice(2), 16) : Number.parseInt(ent.slice(1), 10);
        if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return all;
        return String.fromCodePoint(code);
      }
    }
  });
}

function textCut(buf: Buffer, eof: boolean): number {
  if (eof) return completeUtf8(buf, buf.length);
  if (buf.length < 64 * 1024) return 0;
  let keepFrom = buf.length - 32;
  const amp = buf.lastIndexOf(0x26);
  if (amp >= 0 && buf.length - amp < 64) keepFrom = amp;
  if (keepFrom <= 0) return 0;
  return completeUtf8(buf, keepFrom);
}

/** Largest prefix length `<= end` that ends on a UTF-8 boundary. */
function completeUtf8(buf: Buffer, end: number): number {
  if (end <= 0) return 0;
  let start = end;
  while (start > 0 && (buf[start - 1] & 0xc0) === 0x80) start--;
  if (start === end) return end;
  const lead = buf[start];
  const need = utf8Length(lead);
  return start + need > end ? start : end;
}

function utf8Length(lead: number): number {
  if (lead < 0x80) return 1;
  if ((lead & 0xe0) === 0xc0) return 2;
  if ((lead & 0xf0) === 0xe0) return 3;
  if ((lead & 0xf8) === 0xf0) return 4;
  return 1;
}
