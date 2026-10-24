// Reads the schema a project points at: SQL files or folders of migrations, in path order.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

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
  // Sort by path relative to the folder so `0002/migration.sql` follows `0001/migration.sql`.
  return out.sort((a, b) => (relative(path, a) < relative(path, b) ? -1 : 1));
}

export function upSection(text: string): string {
  let t = text;
  const up = UP_MARKER.exec(t);
  if (up) t = t.slice(up.index);
  for (const m of DOWN_MARKERS) {
    const hit = m.exec(t);
    if (hit) t = t.slice(0, hit.index);
  }
  return t;
}

export function readSchema(files: string[]): SchemaSource {
  const hash = createHash("sha256");
  const parts: string[] = [];
  const starts: SchemaSource["starts"] = [];
  let offset = 0;
  for (const file of files) {
    const raw = readFileSync(file, "utf8");
    hash.update(file).update("\0").update(raw).update("\0");
    const text = upSection(raw).replace(/\s*$/, "") + "\n;\n";
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
