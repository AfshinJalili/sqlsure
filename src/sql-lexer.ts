// A minimal SQL lexer: enough to know which text is plain SQL and which is inside a string, a
// quoted identifier, a dollar-quoted body or a comment. Shared by the .sql file splitter and the
// schema reader.

export interface Visitor {
  /** Plain SQL text outside strings, identifiers and comments. */
  code?(start: number, end: number): void;
  lineComment?(start: number, end: number): void;
  blockComment?(start: number, end: number): void;
}

/** Walks `s` from `from` to `to`, reporting plain code and comments to the visitor. */
export function scan(s: string, from: number, to: number, v: Visitor): void {
  let i = from;
  let codeStart = from;
  const flush = (end: number) => {
    if (end > codeStart) v.code?.(codeStart, end);
  };
  while (i < to) {
    const c = s[i];
    const n = s[i + 1];
    if (c === "-" && n === "-") {
      flush(i);
      const end = Math.min(lineEnd(s, i), to);
      v.lineComment?.(i, end);
      i = end;
      codeStart = i;
    } else if (c === "/" && n === "*") {
      flush(i);
      const commentStart = i;
      let depth = 1;
      i += 2;
      while (i < to && depth > 0) {
        if (s[i] === "/" && s[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (s[i] === "*" && s[i + 1] === "/") {
          depth--;
          i += 2;
        } else i++;
      }
      v.blockComment?.(commentStart, i);
      codeStart = i;
    } else if (c === "'") {
      // E'...' strings allow backslash escapes.
      const escapes = i > 0 && (s[i - 1] === "E" || s[i - 1] === "e") && !isIdentChar(s[i - 2]);
      flush(i);
      i++;
      while (i < to) {
        if (escapes && s[i] === "\\") i += 2;
        else if (s[i] === "'" && s[i + 1] === "'") i += 2;
        else if (s[i] === "'") {
          i++;
          break;
        } else i++;
      }
      codeStart = i;
    } else if (c === '"') {
      flush(i);
      i++;
      while (i < to) {
        if (s[i] === '"' && s[i + 1] === '"') i += 2;
        else if (s[i] === '"') {
          i++;
          break;
        } else i++;
      }
      codeStart = i;
    } else if (c === "$" && !isIdentChar(s[i - 1])) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i, Math.min(to, i + 64)));
      if (m) {
        flush(i);
        const tag = m[0];
        const close = s.indexOf(tag, i + tag.length);
        i = close === -1 || close >= to ? to : close + tag.length;
        codeStart = i;
      } else i++;
    } else i++;
  }
  flush(to);
}

export function isIdentChar(c: string | undefined): boolean {
  return c !== undefined && /[A-Za-z0-9_$]/.test(c);
}

export function lineStart(s: string, i: number): number {
  const p = s.lastIndexOf("\n", i - 1);
  return p === -1 ? 0 : p + 1;
}

export function lineEnd(s: string, i: number): number {
  const p = s.indexOf("\n", i);
  return p === -1 ? s.length : p;
}

export function skipNewline(s: string, i: number): number {
  if (s[i] === "\r") i++;
  if (s[i] === "\n") i++;
  return i;
}
