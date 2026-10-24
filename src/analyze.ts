// Turns a parsed .sql file into typed query descriptions, using the schema loaded into the engine.
import { CODES, type ParsedQuery, type Problem, parseFile } from "./parse-file.ts";
import { Engine, PostgresError } from "./engine.ts";
import { analyzeStatement, fieldNotNull } from "./nullability.ts";
import { outputType, paramType, type TypeRepr } from "./pgtypes.ts";

export interface Column {
  name: string;
  oid: number;
  type: TypeRepr;
  nullable: boolean;
}

export interface Param {
  name: string;
  oid: number;
  type: TypeRepr;
  nullable: boolean;
}

export interface QueryInfo {
  name: string;
  mode: ParsedQuery["mode"];
  doc: string[];
  sql: string;
  params: Param[];
  /** Empty for statements that return no rows. */
  columns: Column[];
}

export interface FileAnalysis {
  queries: QueryInfo[];
  problems: Problem[];
  /** Queries that failed analysis, still exported with loose types so callers do not cascade. */
  failed: { name: string; mode: ParsedQuery["mode"]; sql: string; paramNames: string[] }[];
}

export async function analyzeFile(source: string, engine: Engine): Promise<FileAnalysis> {
  const parsed = parseFile(source);
  const problems = [...parsed.problems];
  const queries: QueryInfo[] = [];
  const failed: FileAnalysis["failed"] = [];
  for (const q of parsed.queries) {
    try {
      const info = await analyzeQuery(q, engine);
      if ("problem" in info) {
        problems.push(info.problem);
        failed.push({ name: q.name, mode: q.mode, sql: q.sql, paramNames: q.params.map((p) => p.name) });
      } else queries.push(info);
    } catch (e) {
      problems.push({
        message: `sqlsure internal error while analyzing "${q.name}": ${e instanceof Error ? e.message : String(e)}`,
        start: q.headerStart,
        length: q.headerLength,
        code: CODES.internal,
      });
      failed.push({ name: q.name, mode: q.mode, sql: q.sql, paramNames: q.params.map((p) => p.name) });
    }
  }
  return { queries, problems, failed };
}

async function analyzeQuery(q: ParsedQuery, engine: Engine): Promise<QueryInfo | { problem: Problem }> {
  let description;
  try {
    description = await engine.describe(q.sql);
  } catch (e) {
    if (!(e instanceof PostgresError)) throw e;
    // Postgres counts characters (code points); JavaScript strings count UTF-16 units.
    const index = e.position !== undefined ? codePointToUtf16(q.sql, e.position - 1) : undefined;
    const at = index !== undefined ? q.toOriginal(index) : q.headerStart;
    return {
      problem: {
        message: e.message,
        start: at,
        length: index !== undefined ? tokenLength(q.sql, index) : q.headerLength,
        code: CODES.postgres,
      },
    };
  }

  const fields = description.fields ?? [];
  if ((q.mode === "one" || q.mode === "many") && description.fields === null) {
    return {
      problem: {
        message: `"${q.name}" is :${q.mode} but returns no rows. Use :exec or :execrows, or add RETURNING.`,
        start: q.headerStart,
        length: q.headerLength,
        code: CODES.mode,
      },
    };
  }

  const seen = new Set<string>();
  for (const f of fields) {
    if (seen.has(f.name) && (q.mode === "one" || q.mode === "many")) {
      return {
        problem: {
          message: `"${q.name}" returns two columns named "${f.name}". Rename one with AS.`,
          start: q.headerStart,
          length: q.headerLength,
          code: CODES.mode,
        },
      };
    }
    seen.add(f.name);
  }

  const params: Param[] = [];
  for (let i = 0; i < q.params.length; i++) {
    const oid = description.params[i] ?? 0;
    params.push({ name: q.params[i].name, oid, type: await resolveParamType(oid, engine), nullable: q.params[i].nullable });
  }

  const columns: Column[] = [];
  if (q.mode === "one" || q.mode === "many") {
    const facts = await analyzeStatement(q.sql, engine);
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      columns.push({
        name: f.name,
        oid: f.dataTypeID,
        type: await resolveOutputType(f.dataTypeID, engine),
        nullable: !(await fieldNotNull(f, i, facts, engine)),
      });
    }
  }
  return { name: q.name, mode: q.mode, doc: q.doc, sql: q.sql, params, columns };
}

async function resolveOutputType(oid: number, engine: Engine): Promise<TypeRepr> {
  return outputType(oid, engine.enums);
}

async function resolveParamType(oid: number, engine: Engine, depth = 0): Promise<TypeRepr> {
  const direct = paramType(oid, engine.enums);
  if (direct.kind !== "string" || depth > 4) return direct;
  // Types pg has no serializer for: look through domains and arrays to the type they are made of.
  const info = await engine.typeInfo(oid);
  if (!info) return direct;
  if (info.typtype === "d" && info.typbasetype) return resolveParamType(info.typbasetype, engine, depth + 1);
  if (info.typcategory === "A" && info.typelem)
    return { kind: "array", element: await resolveParamType(info.typelem, engine, depth + 1), elementNullable: true };
  return direct;
}

function codePointToUtf16(s: string, codePoints: number): number {
  let i = 0;
  for (let n = 0; n < codePoints && i < s.length; n++) {
    const c = s.charCodeAt(i);
    i += c >= 0xd800 && c <= 0xdbff ? 2 : 1;
  }
  return i;
}

function tokenLength(sql: string, at: number): number {
  const m = /^("(?:[^"]|"")*"|[A-Za-z0-9_$.]+|.)/.exec(sql.slice(at));
  return Math.max(1, m ? m[0].length : 1);
}
