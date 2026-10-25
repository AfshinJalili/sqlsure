// Splits a .sql file into named queries and rewrites `:name` parameters to `$n`.
// Synchronous and dependency-free: the runtime loader uses it as well as the type checker.

import { isIdentChar, lineEnd, lineStart, scan, skipNewline } from "./sql-lexer.ts";

export type Mode = "one" | "many" | "exec" | "execrows";
export const MODES: readonly Mode[] = ["one", "many", "exec", "execrows"];

export interface Problem {
  message: string;
  /** UTF-16 offset in the original file. */
  start: number;
  length: number;
  code: number;
}

export interface ParamRef {
  name: string;
  /** `:name?` accepts null. */
  nullable: boolean;
}

export interface ParsedQuery {
  name: string;
  mode: Mode;
  /** Comment lines between `-- name:` and the SQL, for JSDoc. */
  doc: string[];
  /** The SQL with `:name` rewritten to `$1`, `$2`, ... and no trailing semicolon. */
  sql: string;
  /** One entry per `$n`, in order. */
  params: ParamRef[];
  /** Where the `-- name:` line starts. */
  headerStart: number;
  headerLength: number;
  /** Maps an offset in `sql` back to an offset in the original file. */
  toOriginal(offset: number): number;
}

export interface ParsedFile {
  queries: ParsedQuery[];
  problems: Problem[];
}

export const CODES = {
  header: 1,
  noQueries: 2,
  strayText: 3,
  duplicateName: 4,
  positional: 5,
  emptyQuery: 6,
  param: 7,
  postgres: 10,
  schema: 11,
  mode: 12,
  internal: 99,
} as const;

const HEADER = /^--\s*name:\s*(.*)$/;

const RESERVED = new Set(
  ("break case catch class const continue debugger default delete do else enum export extends false finally for " +
    "function if import in instanceof new null return super switch this throw true try typeof var void while with " +
    "yield let static implements interface package private protected public await arguments eval").split(" "),
);
const HEADER_BODY = /^([A-Za-z_$][A-Za-z0-9_$]*)\s+:([A-Za-z]+)\s*$/;

/** The type names a query exports next to its function: `getUser` -> `GetUserParams`, `GetUserRow`. */
export function typeNames(name: string): { params: string; row: string } {
  const pascal = name.charAt(0).toUpperCase() + name.slice(1);
  return { params: `${pascal}Params`, row: `${pascal}Row` };
}

interface Segment {
  /** Offset in the rewritten SQL where this segment starts. */
  out: number;
  /** Offset in the original file. */
  src: number;
}

export function parseFile(source: string): ParsedFile {
  const problems: Problem[] = [];
  const queries: ParsedQuery[] = [];

  // Find header lines that are not inside strings or block comments.
  const headers = findHeaders(source);

  // Text before the first header must be blank or comments.
  const firstStart = headers.length ? headers[0].start : source.length;
  const stray = firstNonComment(source, 0, firstStart);
  if (stray !== -1) {
    problems.push({
      message: headers.length
        ? "SQL outside a named query. Start each query with a line like `-- name: getUser :one`."
        : "No named queries in this file. Start each query with a line like `-- name: getUser :one`.",
      start: stray,
      length: Math.max(1, lineEnd(source, stray) - stray),
      code: headers.length ? CODES.strayText : CODES.noQueries,
    });
  }

  const seen = new Set<string>();
  /** Exported type name -> the query that owns it. */
  const types = new Map<string, string>();
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    const bodyEnd = i + 1 < headers.length ? headers[i + 1].start : source.length;
    const m = HEADER_BODY.exec(h.text);
    if (!m) {
      problems.push({
        message: "Expected `-- name: <identifier> :one|:many|:exec|:execrows`.",
        start: h.start,
        length: h.length,
        code: CODES.header,
      });
      continue;
    }
    const [, name, modeText] = m;
    const mode = modeText.toLowerCase() as Mode;
    if (!MODES.includes(mode)) {
      problems.push({
        message: `Unknown mode :${modeText}. Use :one, :many, :exec or :execrows.`,
        start: h.start,
        length: h.length,
        code: CODES.header,
      });
      continue;
    }
    if (RESERVED.has(name)) {
      problems.push({
        message: `"${name}" is a reserved word in JavaScript and cannot name an export. Pick another name.`,
        start: h.start,
        length: h.length,
        code: CODES.header,
      });
      continue;
    }
    if (seen.has(name)) {
      problems.push({ message: `Duplicate query name "${name}".`, start: h.start, length: h.length, code: CODES.duplicateName });
      continue;
    }
    const { params, row } = typeNames(name);
    const owner = types.get(row);
    if (owner !== undefined) {
      problems.push({
        message: `"${name}" would export types ${params} and ${row}, which "${owner}" already exports. Rename one of them.`,
        start: h.start,
        length: h.length,
        code: CODES.duplicateName,
      });
      continue;
    }
    seen.add(name);
    types.set(params, name).set(row, name);

    // Doc comments: `--` lines right after the header.
    const doc: string[] = [];
    let pos = h.start + h.length;
    pos = skipNewline(source, pos);
    for (;;) {
      const lineStartPos = pos;
      const end = lineEnd(source, lineStartPos);
      const line = source.slice(lineStartPos, end);
      const trimmed = line.trimStart();
      if (lineStartPos < bodyEnd && trimmed.startsWith("--")) {
        doc.push(trimmed.replace(/^--\s?/, ""));
        pos = skipNewline(source, end);
        continue;
      }
      break;
    }
    const bodyStart = Math.min(pos, bodyEnd);
    const rewritten = rewrite(source, bodyStart, bodyEnd, problems);
    if (!rewritten) continue;
    if (!rewritten.sql.trim()) {
      problems.push({ message: `Query "${name}" has no SQL.`, start: h.start, length: h.length, code: CODES.emptyQuery });
      continue;
    }
    queries.push({
      name,
      mode,
      doc,
      sql: rewritten.sql,
      params: rewritten.params,
      headerStart: h.start,
      headerLength: h.length,
      toOriginal: rewritten.toOriginal,
    });
  }
  return { queries, problems };
}

interface Header {
  start: number;
  length: number;
  text: string;
}

function findHeaders(source: string): Header[] {
  const headers: Header[] = [];
  scan(source, 0, source.length, {
    lineComment(start, end) {
      // A header must be the only thing on its line.
      const ls = lineStart(source, start);
      if (source.slice(ls, start).trim() !== "") return;
      const text = source.slice(start, end);
      const m = HEADER.exec(text.trimEnd());
      if (m) headers.push({ start, length: text.trimEnd().length, text: m[1].trim() });
    },
    // sqlc's alternative form: `/* name: getUser :one */` alone on its line.
    blockComment(start, end) {
      const ls = lineStart(source, start);
      if (source.slice(ls, start).trim() !== "" || source.slice(end, lineEnd(source, end)).trim() !== "") return;
      const m = /^\/\*\s*name:\s*(.*?)\s*\*\/$/.exec(source.slice(start, end));
      if (m) headers.push({ start, length: end - start, text: m[1].trim() });
    },
  });
  return headers;
}

function firstNonComment(source: string, from: number, to: number): number {
  let found = -1;
  scan(source, from, to, {
    code(start, end) {
      if (found !== -1) return;
      for (let i = start; i < end; i++) {
        if (!/\s/.test(source[i])) {
          found = i;
          return;
        }
      }
    },
  });
  return found;
}

function rewrite(
  source: string,
  from: number,
  to: number,
  problems: Problem[],
): { sql: string; params: ParamRef[]; toOriginal: (o: number) => number } | null {
  const params: ParamRef[] = [];
  const index = new Map<string, number>();
  const segments: Segment[] = [{ out: 0, src: from }];
  let out = "";
  let copied = from;
  let failed = false;
  // One entry per open `[` in code: true for a subscript (`arr[...]`), false for `ARRAY[...]`.
  const brackets: boolean[] = [];

  scan(source, from, to, {
    code(start, end) {
      for (let i = start; i < end; i++) {
        const c = source[i];
        if (c === "[") {
          brackets.push(!/\barray\s*$/i.test(source.slice(Math.max(from, i - 16), i)));
          continue;
        }
        if (c === "]") {
          brackets.pop();
          continue;
        }
        if (c === "$" && /[0-9]/.test(source[i + 1] ?? "") && !isIdentChar(source[i - 1])) {
          problems.push({
            message: "Positional parameters ($1) are not supported. Use named parameters like :id.",
            start: i,
            length: 2,
            code: CODES.positional,
          });
          failed = true;
          continue;
        }
        if (c !== ":") continue;
        // `::` casts and `:=` assignments.
        if (source[i + 1] === ":" || source[i - 1] === ":" || source[i + 1] === "=") continue;
        const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i + 1, Math.min(end, i + 128)));
        if (!m) continue;
        // `arr[a:b]` slices: inside a subscript, a colon right after a value separates the bounds.
        if (brackets.at(-1) && isSliceColon(source, from, i)) continue;
        const name = m[0];
        let len = 1 + name.length;
        let nullable = false;
        if (source[i + len] === "?") {
          nullable = true;
          len++;
        }
        let n = index.get(name);
        if (n === undefined) {
          params.push({ name, nullable });
          n = params.length;
          index.set(name, n);
        } else if (nullable) {
          params[n - 1].nullable = true;
        }
        out += source.slice(copied, i);
        const placeholder = `$${n}`;
        segments.push({ out: out.length, src: i });
        out += placeholder;
        copied = i + len;
        segments.push({ out: out.length, src: copied });
        i += len - 1;
      }
    },
  });
  if (failed) return null;
  out += source.slice(copied, to);

  // Trim trailing whitespace and one trailing semicolon (outside strings: the scan ended in code).
  let trimmed = out.replace(/\s+$/, "");
  if (trimmed.endsWith(";")) trimmed = trimmed.slice(0, -1).replace(/\s+$/, "");
  if (/;\s*\S/.test(stripLiterals(trimmed))) {
    problems.push({
      message: "One statement per query. Split this into separate `-- name:` blocks.",
      start: from,
      length: Math.max(1, to - from),
      code: CODES.emptyQuery,
    });
    return null;
  }
  return {
    sql: trimmed,
    params,
    toOriginal(o: number) {
      let seg = segments[0];
      for (const s of segments) {
        if (s.out <= o) seg = s;
        else break;
      }
      return seg.src + (o - seg.out);
    },
  };
}

/** Replaces strings, identifiers and comments with spaces, to look for statement separators. */
function stripLiterals(sql: string): string {
  const chars = sql.split("");
  let last = 0;
  scan(sql, 0, sql.length, {
    code(start, end) {
      for (let i = last; i < start; i++) if (chars[i] !== "\n") chars[i] = " ";
      last = end;
    },
  });
  for (let i = last; i < chars.length; i++) chars[i] = " ";
  return chars.join("");
}

/** True when the nearest non-blank character before `at` ends a value: `1`, `n`, `)`, `]`, a quote. */
function isSliceColon(source: string, from: number, at: number): boolean {
  let i = at - 1;
  while (i >= from && /\s/.test(source[i])) i--;
  return i >= from && /[A-Za-z0-9_$)\]'"]/.test(source[i]);
}
