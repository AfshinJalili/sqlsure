// Runs the real `tsc` (TypeScript 7.1) with --runExternalCode over the feature fixtures and the
// diagnostics cases, so these checks go through exactly the path users' builds take.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, rmSync, cpSync, lstatSync, symlinkSync } from "node:fs";
import { join, basename } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname;
const TSC = join(ROOT, "node_modules/.bin/tsc");

export interface TscRun {
  ok: boolean;
  output: string;
  ms: number;
}

/**
 * Projects inside this repository name the content mapper package "sqlsure"; it resolves through
 * node_modules/sqlsure, a link to the repository itself. npm install prunes that link, so it is
 * recreated before every run.
 */
function ensureSelfLink(): void {
  const link = join(ROOT, "node_modules/sqlsure");
  try {
    if (lstatSync(link).isSymbolicLink()) return;
  } catch {}
  rmSync(link, { recursive: true, force: true });
  symlinkSync("..", link);
}

export function tsc(project: string, extra: string[] = [], env: Record<string, string> = {}): TscRun {
  ensureSelfLink();
  const start = performance.now();
  try {
    const out = execFileSync(TSC, ["-p", project, "--runExternalCode", ...extra], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    return { ok: true, output: out, ms: performance.now() - start };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, output: `${err.stdout ?? ""}${err.stderr ?? ""}`, ms: performance.now() - start };
  }
}

export interface Feature {
  id: string;
  description: string;
  passed: boolean;
  errors: string[];
}

export interface FeatureResult {
  features: Feature[];
  /** A copy of one fixture with a wrong expectation must fail, or the checks prove nothing. */
  negativeControlFailed: boolean;
  ms: number;
}

export function runFeatures(): FeatureResult {
  const dir = join(ROOT, "evals/features");
  const run = tsc(join(dir, "tsconfig.json"));
  const lines = run.output.split("\n").filter((l) => /error/.test(l));
  const features: Feature[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".check.ts")).sort()) {
    const id = basename(file, ".check.ts");
    const text = readFileSync(join(dir, file), "utf8");
    const description = /^\/\/ feature: (.*)$/m.exec(text)?.[1] ?? id;
    const sqlFiles = [...text.matchAll(/from "\.\/([^"]+\.sql)"/g)].map((m) => m[1]);
    const errors = lines.filter((l) => l.includes(`features/${file}(`) || sqlFiles.some((s) => l.includes(`features/${s}(`)));
    features.push({ id, description, passed: run.ok || errors.length === 0, errors });
  }
  // If tsc failed with errors that belong to no feature, every feature is suspect.
  if (!run.ok && features.every((f) => f.passed)) for (const f of features) (f.passed = false), f.errors.push(run.output.slice(0, 500));

  // Negative control: break one expectation in a copy and require tsc to fail on it.
  const control = join(ROOT, "evals/.cache/control");
  let negativeControlFailed = false;
  try {
    rmSync(control, { recursive: true, force: true });
    cpSync(dir, control, { recursive: true });
    const f = join(control, "select.check.ts");
    const original = readFileSync(f, "utf8");
    const broken = original.replace("email: string | null", "email: string");
    if (broken !== original) {
      writeFileSync(f, broken);
      const r = tsc(join(control, "tsconfig.json"));
      negativeControlFailed = !r.ok && r.output.includes("select.check.ts");
    }
  } finally {
    rmSync(control, { recursive: true, force: true });
  }
  return { features, negativeControlFailed, ms: run.ms };
}

export interface DiagnosticCase {
  id: string;
  expected: { line: number; col: number; text: string };
  actual: string | null;
  passed: boolean;
}

export function runDiagnostics(): DiagnosticCase[] {
  const dir = join(ROOT, "evals/diagnostics");
  const run = tsc(join(dir, "tsconfig.json"));
  const lines = run.output.split("\n");
  const cases: DiagnosticCase[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql") && f !== "schema.sql").sort()) {
    const text = readFileSync(join(dir, file), "utf8");
    const m = /^-- expect: (\d+):(\d+) (.*)$/m.exec(text);
    if (!m) continue;
    const expected = { line: Number(m[1]), col: Number(m[2]), text: m[3].trim() };
    const actual = lines.find((l) => l.includes(`diagnostics/${file}(`)) ?? null;
    const passed = !!actual && actual.includes(`(${expected.line},${expected.col})`) && actual.includes(expected.text);
    cases.push({ id: basename(file, ".sql"), expected, actual, passed });
  }
  const callerError = lines.find((l) => l.includes("diagnostics/all.check.ts(")) ?? null;
  cases.push({
    id: "callers_stay_quiet",
    expected: { line: 0, col: 0, text: "no error in all.check.ts, which calls failed queries" },
    actual: callerError,
    passed: callerError === null,
  });
  return cases;
}
