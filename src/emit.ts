// The TypeScript the checker sees for a .sql file, and the JavaScript the runtime loads for it.
import type { FileAnalysis, QueryInfo } from "./analyze.ts";
import type { ParsedFile } from "./parse-file.ts";
import { render } from "./pgtypes.ts";

const RUNTIME = "sqlsure/runtime";

function pascal(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function prop(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

function jsdoc(lines: string[], indent = ""): string {
  if (!lines.length) return "";
  return `${indent}/**\n${lines.map((l) => `${indent} * ${l.replace(/\*\//g, "*\\/")}`).join("\n")}\n${indent} */\n`;
}

function sqlDoc(q: { doc: string[]; sql: string }): string[] {
  return [...q.doc, ...(q.doc.length ? [""] : []), "```sql", ...q.sql.split("\n"), "```"];
}

export function emitTypes(analysis: FileAnalysis): string {
  const out: string[] = [`import type { Query, Json, Interval } from "${RUNTIME}";`, ""];
  for (const q of analysis.queries) out.push(emitQueryTypes(q));
  for (const f of analysis.failed) {
    // A query that failed analysis is already an error at its line; keep its callers quiet.
    out.push(`export declare const ${f.name}: Query<any, any>;\n`);
  }
  out.push("export {};", "");
  return out.join("\n");
}

function emitQueryTypes(q: QueryInfo): string {
  const P = `${pascal(q.name)}Params`;
  const R = `${pascal(q.name)}Row`;
  const lines: string[] = [];
  const params = q.params.map((p) => `  ${prop(p.name)}: ${render(p.type)}${p.nullable ? " | null" : ""};`);
  lines.push(params.length ? `export interface ${P} {\n${params.join("\n")}\n}` : `export type ${P} = Record<string, never>;`);
  const hasRows = q.mode === "one" || q.mode === "many";
  if (hasRows) {
    const cols = q.columns.map((c) => `  ${prop(c.name)}: ${render(c.type)}${c.nullable ? " | null" : ""};`);
    lines.push(`export interface ${R} {\n${cols.join("\n")}\n}`);
  }
  const result =
    q.mode === "one" ? `${R} | null` : q.mode === "many" ? `${R}[]` : q.mode === "execrows" ? "number" : "void";
  const paramsArg = q.params.length ? P : "void";
  lines.push(`${jsdoc(sqlDoc(q))}export declare const ${q.name}: Query<${paramsArg}, ${result}>;`);
  return lines.join("\n") + "\n";
}

export function emitRuntime(parsed: ParsedFile): string {
  const out = [`import { defineQuery } from "${RUNTIME}";`];
  for (const q of parsed.queries) {
    const spec = { name: q.name, mode: q.mode, sql: q.sql, params: q.params.map((p) => p.name) };
    out.push(`export const ${q.name} = defineQuery(${JSON.stringify(spec)});`);
  }
  return out.join("\n") + "\n";
}

/** The module a schema file becomes: nothing, so that importing or including it is harmless. */
export const SCHEMA_MODULE = "export {};\n";
