// Mutation testing for the harness itself: each mutation is a deliberate, realistic bug in the
// analyzer. A mutation is "killed" when the oracle suites report at least one violation with it
// switched on. A surviving mutation means the harness cannot see that class of bug.
//
// Not listed: ignoring set operations, an equivalent mutant (Postgres reports no column origin
// through UNION/INTERSECT/EXCEPT, so it changes nothing; tests/postgres-behavior.test.ts pins it).
import { mutations } from "../../src/nullability.ts";
import { typeMutations } from "../../src/pgtypes.ts";
import { loadSuiteDir, runSuite } from "./suite.ts";

const ROOT = new URL("../..", import.meta.url).pathname;

export const MUTATIONS: { id: string; description: string; target: Set<string> }[] = [
  { id: "ignore-outer-joins", description: "forget that LEFT/RIGHT/FULL JOIN makes a side nullable", target: mutations },
  { id: "skip-cte-references", description: "forget that a CTE joined on the nullable side makes its tables nullable", target: mutations },
  { id: "ignore-grouping-sets", description: "forget that ROLLUP/CUBE/GROUPING SETS null out grouped columns", target: mutations },
  { id: "trust-computed-columns", description: "treat every computed expression as non-null", target: mutations },
  { id: "ignore-not-null-constraints", description: "treat every table column as NOT NULL", target: mutations },
  { id: "int8-as-number", description: "type bigint as number (pg returns a string)", target: typeMutations },
  { id: "numeric-as-number", description: "type numeric as number (pg returns a string)", target: typeMutations },
  { id: "date-as-string", description: "type date/timestamp as string (pg returns Date)", target: typeMutations },
  { id: "non-null-array-elements", description: "assume array elements are never NULL", target: typeMutations },
];

export interface MutationResult {
  id: string;
  description: string;
  killed: boolean;
  violations: number;
}

export async function runMutations(log?: (s: string) => void): Promise<MutationResult[]> {
  const results: MutationResult[] = [];
  for (const m of MUTATIONS) {
    m.target.add(m.id);
    try {
      let violations = 0;
      for (const name of ["shop", "traps"]) {
        const r = await runSuite({ ...loadSuiteDir(`${ROOT}evals/suites/${name}`, `mut_${name}`), seeds: [1], runsPerQuery: 6 });
        violations += r.violations.length;
      }
      results.push({ id: m.id, description: m.description, killed: violations > 0, violations });
      log?.(`  mutation ${m.id}: ${violations > 0 ? "killed" : "SURVIVED"} (${violations} violations)`);
    } finally {
      m.target.delete(m.id);
    }
  }
  return results;
}
