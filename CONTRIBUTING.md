# Contributing

```sh
npm ci
npm run typecheck   # tsc over src, tests and evals
npm test            # unit tests (node --test, no database needed)
npm run build       # dist/, what the package ships
```

The code is TypeScript run directly by Node (type stripping). Use a Node version from `engines` in package.json.

| File | Concern |
| --- | --- |
| `src/parse-file.ts` | Splits a `.sql` file into named queries and rewrites `:params` to `$n`. Shared by `tsc` and the run-time hook. |
| `src/engine.ts` | The in-process Postgres (PGlite) holding the schema; describes statements. |
| `src/nullability.ts` | Decides which output columns can never be NULL. |
| `src/pgtypes.ts` | What `pg` returns and accepts for each Postgres type. |
| `src/analyze.ts` | Combines the above into typed query descriptions. |
| `src/emit.ts` | The TypeScript `tsc` sees, and the JavaScript Node loads. |
| `src/mapper.ts`, `src/rpc.ts` | The content mapper protocol `tsc` speaks. |
| `src/register.ts`, `src/runtime.ts` | The run-time hook and the query functions. |
| `src/vite.ts`, `src/esbuild.ts`, `src/bun.ts` | Loading `.sql` files in Vite/Vitest, esbuild and Bun; each calls `compileSqlModule` in `emit.ts`. |

## Evals

The evals need a Postgres server. Start a throwaway one and run them:

```sh
docker run -d --name sqlsure-evals -p 127.0.0.1:54329:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17
npm run evals          # everything, about 6 minutes; non-zero exit when a threshold is missed
npm run evals:quick    # without the sqlc corpus and the benchmarks
npm run smoke          # pack, install into a copy of examples/basic, type-check, test and run it (needs Bun)
```

`SQLSURE_EVAL_PG` points them at another server (default `postgres://postgres@127.0.0.1:54329/postgres`). `npm run evals -- --update-readme` also rewrites the generated tables in README.md.

What `npm run evals` checks:

1. **Oracle suites** (`evals/suites`): a realistic shop schema, and traps written to fool nullability inference (outer joins inside subqueries, CTEs on the nullable side, `LATERAL`, `ROLLUP`, `UNION … NULL`, views, composite expansion, schema shadowing, upserts, JSON `null`). Each query runs on real Postgres, and every returned value is checked against its type; real Postgres' `PREPARE` must also agree with every column type. Hand-labeled ground truth (`expect.json`) measures precision.
2. **The sqlc corpus**: sqlc's end-to-end tests at a pinned commit, deduplicated. Breadth counts the queries real Postgres accepts that sqlsure types; every typed query then goes through the same oracle on seeded data.
3. **Feature fixtures** (`evals/features`): exact type assertions compiled by the real `tsc --runExternalCode`, plus a negative control that must fail.
4. **Diagnostics** (`evals/diagnostics`): broken files whose errors must land on the exact line and column, while the TypeScript that calls the broken queries stays error-free.
5. **Mutation testing**: realistic bugs switched on inside sqlsure one at a time; the oracle must report violations for each.
6. **Performance**: `tsc` with 10, 100 and 1,000 queries, and per-call overhead over plain `pg`.

The ground-truth labels and the trap queries were written by sqlsure's authors. That is why the external corpus and the mutation tests exist: the first measures sqlsure on SQL it was not tuned for, the second proves the oracle can see the bugs it claims to rule out.

## Changes

- A bug fix comes with a test that fails without it: a unit test in `tests/`, and for a typing bug, a trap query in `evals/suites/traps` too.
- Thresholds in `evals/run.ts` are not lowered to make a change pass.
- Add a line under `## [Unreleased]` in [CHANGELOG.md](./CHANGELOG.md).

CI runs the unit tests, the smoke test and the full evals on every push and pull request. Releases are described in [RELEASING.md](./RELEASING.md).
