// The TypeScript 7.1 content mapper process. tsc starts it with `--runExternalCode` and asks it to
// turn each .sql file into virtual TypeScript.
import { serve } from "./rpc.ts";
import { Project } from "./project.ts";
import { emitTypes, SCHEMA_MODULE } from "./emit.ts";
import { parseFile, type Problem } from "./parse-file.ts";
import type { Options } from "./schema.ts";

export const DIAGNOSTIC_SOURCE = "sqlsure";
const VERSION = "0.1.0";

const projects = new Map<string, Project>();

function utf8Range(source: string, start: number, length: number): { start: number; length: number } {
  const before = Buffer.byteLength(source.slice(0, start), "utf8");
  const inside = Buffer.byteLength(source.slice(start, start + length), "utf8");
  return { start: before, length: Math.max(inside, 1) };
}

function toDiagnostic(content: string, p: Problem) {
  return { messageText: p.message, code: p.code, ...utf8Range(content, p.start, p.length) };
}

const KNOWN_OPTIONS = new Set(["schema"]);

export const handlers = {
  initialize(params: unknown) {
    const { protocolVersion } = (params ?? {}) as { protocolVersion?: number };
    return { protocolVersion: protocolVersion ?? 1, positionEncoding: "utf-8", diagnosticSource: DIAGNOSTIC_SOURCE };
  },
  openProject(params: unknown) {
    const { projectHandle, options, configFileName } = (params ?? {}) as {
      projectHandle: string;
      options?: Record<string, unknown> | null;
      configFileName?: string;
    };
    const optionDiagnostics: { path: unknown[]; messageText: string; code: number }[] = [];
    for (const key of Object.keys(options ?? {})) {
      if (!KNOWN_OPTIONS.has(key))
        optionDiagnostics.push({ path: [key], messageText: `sqlsure has no option "${key}".`, code: 20 });
    }
    const schema = options?.schema;
    if (schema !== undefined && typeof schema !== "string" && !(Array.isArray(schema) && schema.every((s) => typeof s === "string")))
      optionDiagnostics.push({ path: ["schema"], messageText: '"schema" must be a path or a list of paths.', code: 21 });
    const project = new Project((options ?? {}) as Options, configFileName ?? "");
    projects.set(projectHandle, project);
    return {
      configIdentity: `${VERSION}:${project.identity}`,
      watchedFiles: project.schemaFiles,
      optionDiagnostics,
    };
  },
  async transform(params: unknown) {
    const { fileName, content, projectHandle } = params as { fileName: string; content: string; projectHandle: string };
    let project = projects.get(projectHandle);
    if (!project) {
      project = new Project({}, "");
      projects.set(projectHandle, project);
    }
    if (project.isSchemaFile(fileName)) return { extension: ".mts", text: SCHEMA_MODULE, diagnostics: [] };
    const analysis = await project.analyze(content);
    if (!analysis.queries.length && !analysis.failed.length) {
      // Setup failed (no schema, schema error): keep every import of the file quiet.
      for (const q of parseFile(content).queries)
        analysis.failed.push({ name: q.name, mode: q.mode, sql: q.sql, paramNames: q.params.map((p) => p.name) });
    }
    return {
      extension: ".mts",
      text: emitTypes(analysis),
      diagnostics: analysis.problems.map((p) => toDiagnostic(content, p)),
    };
  },
  closeProject(params: unknown) {
    const { projectHandle } = (params ?? {}) as { projectHandle?: string };
    if (projectHandle) projects.delete(projectHandle);
    return {};
  },
};

export function main(): void {
  serve(handlers);
}
