// `npm run evals`: every check sqlsure's claims rest on, one scorecard, and a non-zero exit code
// when any threshold is missed. The README's tables are generated from this run, not written by
// hand.
//
//   --skip-corpus      skip the sqlc corpus (about 4 minutes)
//   --skip-perf        skip the tsc and run-time benchmarks
//   --skip-mutations   skip mutation testing of the harness
//   --update-readme    rewrite the generated sections of README.md
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSuiteDir, runSuite, type SuiteResult, type Violation } from "./lib/suite.ts";
import { runCorpus, type CorpusResult } from "./lib/corpus.ts";
import { runFeatures, runDiagnostics, type FeatureResult, type DiagnosticCase } from "./lib/tsc.ts";
import { runMutations, type MutationResult } from "./lib/mutations.ts";
import { runPerf, type PerfResult } from "./lib/perf.ts";
import { admin } from "./lib/pg.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const args = new Set(process.argv.slice(2));
const log = (s: string) => console.log(s);

export const THRESHOLDS = {
  soundnessViolations: 0,
  breadthPercent: 90,
  precisionPercent: 85,
  featuresPercent: 100,
  diagnosticsPercent: 100,
  mutationKillPercent: 100,
};

interface Scorecard {
  date: string;
  postgres: string;
  thresholds: typeof THRESHOLDS;
  soundness: { violations: Violation[]; valuesChecked: number; rowsChecked: number; queriesExecuted: number; schemas: number };
  precision: { labeledNonnull: number; inferredNonnull: number; percent: number; misses: string[] };
  breadth: { percent: number | null; typed: number; acceptedByPostgres: number; refusedByDesign: number; corpus: Omit<CorpusResult, "dynamic"> | null };
  features: FeatureResult;
  diagnostics: DiagnosticCase[];
  mutations: MutationResult[] | null;
  perf: PerfResult | null;
  suites: Omit<SuiteResult, "violations">[];
  checks: { name: string; value: string; threshold: string; passed: boolean }[];
  passed: boolean;
}

const pct = (a: number, b: number) => (b === 0 ? 100 : (100 * a) / b);

async function main() {
  const postgres = await admin(async (c) => (await c.query("show server_version")).rows[0].server_version as string);
  log(`sqlsure evals — oracle: Postgres ${postgres}`);

  log("\n[1/6] oracle suites");
  const suites: SuiteResult[] = [];
  for (const name of ["shop", "traps"]) {
    const r = await runSuite(loadSuiteDir(join(ROOT, "evals/suites", name), name));
    suites.push(r);
    log(`  ${name}: ${r.analyzed}/${r.queries} typed, ${r.valuesChecked} values checked, ${r.violations.length} violations`);
  }

  let corpus: CorpusResult | null = null;
  if (!args.has("--skip-corpus")) {
    log("\n[2/6] sqlc corpus (breadth + dynamic soundness)");
    corpus = await runCorpus(join(ROOT, "evals/.cache"), { dynamic: true, log });
    log(`  ${corpus.typed}/${corpus.acceptedByPostgres} typed`);
  } else log("\n[2/6] sqlc corpus: skipped");

  log("\n[3/6] feature fixtures (tsc --runExternalCode)");
  const features = runFeatures();
  log(`  ${features.features.filter((f) => f.passed).length}/${features.features.length} passed; negative control ${features.negativeControlFailed ? "failed as it must" : "DID NOT FAIL"}`);

  log("\n[4/6] diagnostics");
  const diagnostics = runDiagnostics();
  log(`  ${diagnostics.filter((d) => d.passed).length}/${diagnostics.length} at the exact line and column`);

  let mutations: MutationResult[] | null = null;
  if (!args.has("--skip-mutations")) {
    log("\n[5/6] mutation testing of the oracle");
    mutations = await runMutations(log);
  } else log("\n[5/6] mutations: skipped");

  let perf: PerfResult | null = null;
  if (!args.has("--skip-perf")) {
    log("\n[6/6] performance");
    perf = await runPerf({ sizes: [10, 100, 1000], log });
  } else log("\n[6/6] performance: skipped");

  // ---- scoring ----
  const dynamicSuites = corpus?.dynamic ?? [];
  const allViolations = [...suites, ...dynamicSuites].flatMap((s) => s.violations);
  const labeledNonnull = suites.reduce((n, s) => n + s.labeled.nonnull, 0);
  const inferredNonnull = suites.reduce((n, s) => n + s.labeled.nonnullInferredNonnull, 0);
  const precision = pct(inferredNonnull, labeledNonnull);
  const refusedByDesign = corpus?.failures.filter((f) => /two columns named/.test(f.reason)).length ?? 0;
  const breadth = corpus ? pct(corpus.typed, corpus.acceptedByPostgres) : null;
  const featurePct = pct(features.features.filter((f) => f.passed).length, features.features.length);
  const diagPct = pct(diagnostics.filter((d) => d.passed).length, diagnostics.length);
  const killPct = mutations ? pct(mutations.filter((m) => m.killed).length, mutations.length) : null;

  const checks: Scorecard["checks"] = [
    { name: "Soundness: values contradicting their type", value: String(allViolations.length), threshold: `= ${THRESHOLDS.soundnessViolations}`, passed: allViolations.length <= THRESHOLDS.soundnessViolations },
    { name: "Precision: truly non-null columns typed non-null", value: `${precision.toFixed(1)}% (${inferredNonnull}/${labeledNonnull})`, threshold: `≥ ${THRESHOLDS.precisionPercent}%`, passed: precision >= THRESHOLDS.precisionPercent },
    {
      name: "Breadth: real-world queries typed (sqlc corpus)",
      value: breadth === null ? "skipped" : `${breadth.toFixed(1)}% (${corpus!.typed}/${corpus!.acceptedByPostgres})`,
      threshold: `≥ ${THRESHOLDS.breadthPercent}%`,
      passed: breadth === null || breadth >= THRESHOLDS.breadthPercent,
    },
    { name: "Feature fixtures (exact types through tsc)", value: `${featurePct.toFixed(0)}%`, threshold: `= ${THRESHOLDS.featuresPercent}%`, passed: featurePct >= THRESHOLDS.featuresPercent },
    { name: "Negative control fails", value: features.negativeControlFailed ? "yes" : "no", threshold: "yes", passed: features.negativeControlFailed },
    { name: "Diagnostics at exact line:column", value: `${diagPct.toFixed(0)}%`, threshold: `= ${THRESHOLDS.diagnosticsPercent}%`, passed: diagPct >= THRESHOLDS.diagnosticsPercent },
    {
      name: "Mutations killed by the oracle",
      value: killPct === null ? "skipped" : `${killPct.toFixed(0)}% (${mutations!.filter((m) => m.killed).length}/${mutations!.length})`,
      threshold: `= ${THRESHOLDS.mutationKillPercent}%`,
      passed: killPct === null || killPct >= THRESHOLDS.mutationKillPercent,
    },
  ];
  const passed = checks.every((c) => c.passed);

  const { dynamic: _dynamic, ...corpusSummary } = corpus ?? ({} as CorpusResult);
  const card: Scorecard = {
    date: new Date().toISOString(),
    postgres,
    thresholds: THRESHOLDS,
    soundness: {
      violations: allViolations,
      valuesChecked: [...suites, ...dynamicSuites].reduce((n, s) => n + s.valuesChecked, 0),
      rowsChecked: [...suites, ...dynamicSuites].reduce((n, s) => n + s.rowsChecked, 0),
      queriesExecuted: [...suites, ...dynamicSuites].reduce((n, s) => n + s.executedQueries, 0),
      schemas: suites.length + dynamicSuites.length,
    },
    precision: { labeledNonnull, inferredNonnull, percent: precision, misses: suites.flatMap((s) => s.precisionMisses) },
    breadth: { percent: breadth, typed: corpus?.typed ?? 0, acceptedByPostgres: corpus?.acceptedByPostgres ?? 0, refusedByDesign, corpus: corpus ? corpusSummary : null },
    features,
    diagnostics,
    mutations,
    perf,
    suites: suites.map(({ violations: _v, ...rest }) => rest),
    checks,
    passed,
  };

  writeFileSync(join(ROOT, "evals/scorecard.json"), JSON.stringify(card, null, 2) + "\n");
  const md = renderScorecard(card);
  writeFileSync(join(ROOT, "SCORECARD.md"), md);
  if (args.has("--update-readme")) updateReadme(card);

  log("\n" + table(checks));
  if (allViolations.length) {
    log("\nSoundness violations:");
    for (const v of allViolations.slice(0, 50)) log(`  ${v.suite} ${v.query}.${v.column}: ${v.kind} — ${v.detail}`);
  }
  log(`\n${passed ? "PASS" : "FAIL"} — full report in SCORECARD.md`);
  process.exit(passed ? 0 : 1);
}

function table(checks: Scorecard["checks"]): string {
  const rows = [["", "Check", "Result", "Threshold"], ...checks.map((c) => [c.passed ? "✅" : "❌", c.name, c.value, c.threshold])];
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((c, i) => c.padEnd(widths[i])).join("  ")).join("\n");
}

function mdTable(head: string[], rows: string[][]): string {
  return [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

function checksTable(card: Scorecard): string {
  return mdTable(["", "Check", "Result", "Threshold"], card.checks.map((c) => [c.passed ? "✅" : "❌", c.name, c.value, c.threshold]));
}

function featuresTable(card: Scorecard): string {
  return mdTable(["", "Feature"], card.features.features.map((f) => [f.passed ? "✅" : "❌", f.description]));
}

function perfTable(card: Scorecard): string {
  if (!card.perf) return "_skipped_";
  const t = mdTable(
    ["Queries", "tsc, warm", "tsc, first run on a machine", "plain tsc (no .sql)", "per query"],
    card.perf.tsc.map((x) => [String(x.queries), `${(x.warmMs / 1000).toFixed(2)} s`, `${(x.coldMs / 1000).toFixed(2)} s`, `${(x.baselineMs / 1000).toFixed(2)} s`, `${x.perQueryMs.toFixed(1)} ms`]),
  );
  const r = card.perf.runtime;
  return `${t}\n\nRun time: ${r.overheadUsPerCall.toFixed(1)} µs added per query call over calling \`pg\` directly (${(r.rawMsPerCall * 1000).toFixed(0)} µs raw round trip to a local Postgres, median of 5 × ${r.calls} calls).`;
}

function renderScorecard(card: Scorecard): string {
  const c = card.breadth.corpus;
  const lines = [
    "# sqlsure scorecard",
    "",
    `Generated by \`npm run evals\` on ${card.date.slice(0, 10)} against Postgres ${card.postgres}. Do not edit by hand.`,
    "",
    checksTable(card),
    "",
    "## Soundness",
    "",
    `Every query was typed by sqlsure, then executed by real Postgres through the real \`pg\` driver — on an empty database and on randomly seeded ones (NULL wherever allowed, JSON \`null\`, arrays holding NULL, parents without children) — and every returned value was checked against the claimed type.`,
    "",
    `- ${card.soundness.valuesChecked.toLocaleString("en")} values in ${card.soundness.rowsChecked.toLocaleString("en")} rows, from ${card.soundness.queriesExecuted} queries over ${card.soundness.schemas} schemas`,
    `- Real Postgres' own \`PREPARE\` must report the same column types as sqlsure for every query`,
    `- Violations: **${card.soundness.violations.length}**`,
    ...card.soundness.violations.slice(0, 50).map((v) => `  - \`${v.suite}\` ${v.query}.${v.column}: ${v.kind} — ${v.detail}`),
    "",
    "## Precision",
    "",
    `Hand-labeled ground truth in \`evals/suites/*/expect.json\`: ${card.precision.inferredNonnull} of ${card.precision.labeledNonnull} truly non-null columns are typed non-null (${card.precision.percent.toFixed(1)}%). The misses, where sqlsure says \`| null\` although the value can never be NULL:`,
    "",
    ...card.precision.misses.map((m) => `- \`${m}\``),
    "",
    "## Breadth",
    "",
    c
      ? [
          `Corpus: [${c.source}](https://github.com/sqlc-dev/sqlc/tree/${c.commit}/internal/endtoend/testdata) at \`${c.commit.slice(0, 7)}\`, PostgreSQL cases only, deduplicated (${c.casesDeduplicated} duplicates), excluding ${c.casesExpectedToFail} cases sqlc itself expects to fail.`,
          "",
          `- ${c.queries} queries; ${c.translated} translated from sqlc syntax (\`sqlc.arg(x)\`, \`@x\`, \`$1\` → \`:x\`)`,
          `- Not translatable: ${c.unsupportedSyntax.map((u) => `${u.reason} (${u.count})`).join(", ") || "none"}`,
          `- Real Postgres rejects ${c.rejectedByPostgres} (excluded)`,
          `- Real Postgres accepts ${c.acceptedByPostgres}; sqlsure types **${c.typed}** (${card.breadth.percent!.toFixed(1)}%)`,
          `- Of the ${c.failures.length} not typed, ${card.breadth.refusedByDesign} are refused by design: two output columns with the same name, which \`pg\` silently collapses into one`,
          "",
          ...c.failures.map((f) => `  - \`${f.case}\` ${f.query}: ${f.reason}`),
        ].join("\n")
      : "_skipped_",
    "",
    "## Features",
    "",
    featuresTable(card),
    "",
    "## Diagnostics",
    "",
    mdTable(["", "Case", "Expected"], card.diagnostics.map((d) => [d.passed ? "✅" : "❌", d.id, `${d.expected.line}:${d.expected.col} ${d.expected.text}`])),
    "",
    "## Mutation testing",
    "",
    "Each mutation is a deliberate bug switched on inside sqlsure; the oracle must catch it.",
    "",
    card.mutations ? mdTable(["", "Mutation", "Violations found"], card.mutations.map((m) => [m.killed ? "✅ killed" : "❌ survived", m.description, String(m.violations)])) : "_skipped_",
    "",
    "## Performance",
    "",
    perfTable(card),
    "",
  ];
  return lines.join("\n");
}

function replaceBetween(text: string, name: string, content: string): string {
  const start = `<!-- ${name}:start -->`;
  const end = `<!-- ${name}:end -->`;
  const i = text.indexOf(start);
  const j = text.indexOf(end);
  if (i === -1 || j === -1) return text;
  return `${text.slice(0, i + start.length)}\n${content}\n${text.slice(j)}`;
}

function updateReadme(card: Scorecard): void {
  const path = join(ROOT, "README.md");
  let text = readFileSync(path, "utf8");
  text = replaceBetween(text, "scorecard", checksTable(card));
  text = replaceBetween(text, "features", featuresTable(card));
  text = replaceBetween(text, "perf", perfTable(card));
  writeFileSync(path, text);
}

await main();
