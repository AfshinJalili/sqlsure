// Reads the schema a project points at: SQL files or folders of migrations, in path order.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { lineStart, scan } from "./sql-lexer.ts";

export interface SchemaSource {
  files: string[];
  sql: string;
  hash: string;
  /** Where each file starts in `sql`. */
  starts: { file: string; start: number }[];
}

export interface Options {
  schema?: string | string[];
}

/** Down sections of common migration tools, which must not run. */
const DOWN_MARKERS = [/^--\s*migrate:down\b/im, /^--\s*\+goose\s+down\b/im, /^--\s*!\s*down\b/im];
const UP_MARKER = /^--\s*migrate:up\b/im;

export function resolveSchemaFiles(options: Options, configFileName: string): string[] {
  const base = configFileName ? dirname(configFileName) : process.cwd();
  const entries = options.schema === undefined ? [] : Array.isArray(options.schema) ? options.schema : [options.schema];
  const files: string[] = [];
  for (const entry of entries) {
    const path = isAbsolute(entry) ? entry : resolve(base, entry);
    files.push(...expand(path));
  }
  return files;
}

function expand(path: string): string[] {
  let st;
  try {
    st = statSync(path);
  } catch {
    throw new Error(`sqlsure: schema path ${path} does not exist.`);
  }
  if (st.isFile()) return [path];
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const p = join(dir, name);
      const s = statSync(p);
      if (s.isDirectory()) visit(p);
      else if (name.endsWith(".sql")) out.push(p);
    }
  };
  visit(path);
  // By path relative to the folder, so `0002/migration.sql` follows `0001/migration.sql`. Flyway's
  // repeatable migrations (`R__views.sql`) run after the versioned ones, in plain alphabetical
  // order of their names, as Flyway runs them: `R__view10` before `R__view2`.
  const repeatable = (p: string) => /^R__/.test(basename(p));
  const order = (a: string, b: string) => {
    if (repeatable(a) !== repeatable(b)) return repeatable(a) ? 1 : -1;
    if (!repeatable(a)) return naturalCompare(relative(path, a), relative(path, b));
    return basename(a) < basename(b) ? -1 : basename(a) > basename(b) ? 1 : 0;
  };
  return out.filter((p) => !isDownFile(basename(p))).sort(order);
}

/** golang-migrate's down migrations (`1_x.down.sql`) and Flyway's undo migrations (`U2__x.sql`) never run. */
function isDownFile(name: string): boolean {
  return name.endsWith(".down.sql") || /^U\d[\d._]*__/.test(name);
}

/**
 * Orders runs of digits by their number, so `V2__` comes before `V10__` and `2_x` before `10_x`;
 * everything else by code unit, which keeps zero-padded and timestamped names in their usual order.
 */
function naturalCompare(a: string, b: string): number {
  const digit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (digit(a[i]) && digit(b[j])) {
      let ei = i;
      let ej = j;
      while (digit(a[ei])) ei++;
      while (digit(b[ej])) ej++;
      const x = a.slice(i, ei).replace(/^0+(?=\d)/, "");
      const y = b.slice(j, ej).replace(/^0+(?=\d)/, "");
      if (x.length !== y.length) return x.length - y.length;
      if (x !== y) return x < y ? -1 : 1;
      i = ei;
      j = ej;
    } else {
      if (a[i] !== b[j]) return a[i] < b[j] ? -1 : 1;
      i++;
      j++;
    }
  }
  return a.length - i - (b.length - j);
}

/** psql meta-commands pg_dump and migration scripts use that change nothing in the schema. */
const HARMLESS_META_COMMANDS = new Set(["restrict", "unrestrict", "connect", "c", "set", "unset", "encoding", "echo", "qecho", "warn", "pset", "timing"]);

/**
 * The SQL of one schema file that should run: its up section, with harmless psql meta-commands
 * blanked out. Blanking keeps every line where it was, so errors point at the right line.
 */
export function schemaText(text: string, file: string): string {
  let t = text;
  const up = UP_MARKER.exec(t);
  if (up) t = blank(t, 0, up.index);
  for (const m of DOWN_MARKERS) {
    const hit = m.exec(t);
    if (hit) t = t.slice(0, hit.index);
  }
  const code: [number, number][] = [];
  scan(t, 0, t.length, { code: (start, end) => code.push([start, end]) });
  for (const m of t.matchAll(/^\\([A-Za-z]+)[^\n]*/gm)) {
    const at = m.index;
    if (!code.some(([start, end]) => start <= at && at < end)) continue; // inside a string, body or comment
    if (!HARMLESS_META_COMMANDS.has(m[1].toLowerCase())) {
      const line = t.slice(0, lineStart(t, at)).split("\n").length;
      throw new Error(
        `sqlsure: ${file}:${line}: psql meta-command \\${m[1]} is not supported in a schema file. Run the SQL it stands for, or list the files it includes in "schema".`,
      );
    }
    t = blank(t, at, at + m[0].length);
  }
  return t;
}

/** Replaces text with spaces, keeping newlines, so positions and line numbers do not move. */
function blank(t: string, from: number, to: number): string {
  return t.slice(0, from) + t.slice(from, to).replace(/[^\n]/g, " ") + t.slice(to);
}

export function readSchema(files: string[]): SchemaSource {
  const hash = createHash("sha256");
  const parts: string[] = [];
  const starts: SchemaSource["starts"] = [];
  let offset = 0;
  for (const file of files) {
    const raw = readFileSync(file, "utf8");
    hash.update(file).update("\0").update(raw).update("\0");
    const text = schemaText(raw, file).replace(/\s*$/, "") + "\n;\n";
    starts.push({ file, start: offset });
    parts.push(text);
    offset += text.length;
  }
  return { files, sql: parts.join(""), hash: hash.digest("hex"), starts };
}

/** "schema.sql:12:5" for a 1-based character position in the combined schema. */
export function locate(schema: SchemaSource, position: number | undefined): string {
  if (position === undefined || !schema.starts.length) return schema.files.join(", ");
  const at = position - 1;
  let current = schema.starts[0];
  for (const s of schema.starts) if (s.start <= at) current = s;
  const before = schema.sql.slice(current.start, at);
  const line = before.split("\n").length;
  const col = at - (current.start + before.lastIndexOf("\n") + 1) + 1;
  return `${current.file}:${line}:${col}`;
}
