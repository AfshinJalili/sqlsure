// One project = one tsconfig `contentMappers` entry: its options, its schema, and the engine that
// holds that schema. Engines are shared between projects with the same schema.
import { statSync } from "node:fs";
import { Engine, extensionsIn } from "./engine.ts";
import { analyzeFile, type FileAnalysis } from "./analyze.ts";
import { CODES, type Problem } from "./parse-file.ts";
import { locate, readSchema, resolveSchemaFiles, type Options, type SchemaSource } from "./schema.ts";

const engines = new Map<string, Promise<Engine>>();

async function engineFor(schema: SchemaSource): Promise<Engine> {
  let e = engines.get(schema.hash);
  if (!e) {
    e = (async () => {
      const engine = await Engine.create(extensionsIn(schema.sql));
      if (schema.sql.trim()) await engine.loadSchema(schema.sql);
      return engine;
    })();
    engines.set(schema.hash, e);
    e.catch(() => engines.delete(schema.hash));
    // Editors keep the process alive while the schema changes: keep only the latest few.
    while (engines.size > 3) {
      const [oldest, engine] = engines.entries().next().value!;
      engines.delete(oldest);
      engine.then((x) => x.close()).catch(() => {});
    }
  } else {
    engines.delete(schema.hash);
    engines.set(schema.hash, e);
  }
  return e;
}

/** Closes every shared engine, so a process that is done analyzing can exit. */
export async function closeEngines(): Promise<void> {
  const all = [...engines.values()];
  engines.clear();
  await Promise.all(all.map((e) => e.then((x) => x.close()).catch(() => {})));
}

export class Project {
  readonly options: Options;
  readonly configFileName: string;
  private files: string[] = [];
  private stamps = "";
  private schema: SchemaSource | undefined;
  private setupError: string | undefined;

  constructor(options: Options, configFileName: string) {
    this.options = options;
    this.configFileName = configFileName;
    this.refresh();
  }

  /** Re-reads the schema when any of its files changed since the last read. */
  refresh(): void {
    try {
      this.files = resolveSchemaFiles(this.options, this.configFileName);
      const stamps = this.files.map((f) => `${f}:${statSync(f).mtimeMs}`).join("|");
      if (stamps !== this.stamps || !this.schema) {
        this.schema = readSchema(this.files);
        this.stamps = stamps;
      }
      this.setupError = undefined;
    } catch (e) {
      this.setupError = e instanceof Error ? e.message : String(e);
      this.schema = undefined;
    }
  }

  get schemaFiles(): string[] {
    return this.files;
  }

  get identity(): string {
    return this.schema?.hash ?? `error:${this.setupError}`;
  }

  isSchemaFile(fileName: string): boolean {
    return this.files.includes(fileName);
  }

  async analyze(content: string): Promise<FileAnalysis> {
    this.refresh();
    const schema = this.schema;
    const fail = (message: string): FileAnalysis => ({
      queries: [],
      failed: [],
      problems: [{ message, start: 0, length: 1, code: CODES.schema }],
    });
    if (!schema) return fail(this.setupError ?? "sqlsure: no schema.");
    if (!schema.files.length)
      return fail('sqlsure needs your schema. Add "options": { "schema": "./schema.sql" } to the sqlsure entry in tsconfig.json.');
    let engine: Engine;
    try {
      engine = await engineFor(schema);
    } catch (e) {
      const err = e as { message?: string; position?: number };
      return fail(`The schema failed to load at ${locate(schema, err.position)}: ${err.message ?? String(e)}`);
    }
    return analyzeFile(content, engine);
  }
}

export type { Problem };
