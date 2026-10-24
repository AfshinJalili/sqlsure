# sqlsure

**Import a `.sql` file in TypeScript. Get types Postgres itself vouches for. No codegen.**

```sql
-- users.sql
-- name: getUser :one
SELECT id, email, display_name, created_at FROM users WHERE id = :id;
```

```ts
import { getUser } from "./users.sql";

const user = await getUser(pool, { id: 42 });
//    ^? { id: number; email: string; display_name: string | null; created_at: Date } | null
```

Drop a column in your schema and every query that touches it fails `tsc`, pointing at the exact line in the `.sql` file. There is no generator to run, no generated files to commit, and nothing to forget to regenerate.

sqlsure is a [TypeScript 7.1 content mapper](https://github.com/microsoft/typescript-go/pull/4712): `tsc` hands it each `.sql` file and it returns the types. Your queries are checked by a real Postgres (compiled to WebAssembly, running in-process, holding only your schema), so any SQL Postgres accepts works, and every error message is Postgres' own.

## Why trust the types?

Typed-SQL tools usually ask you to take their word for it. sqlsure ships the evidence: an eval suite that runs every query on a **real Postgres through the real `pg` driver** — on an empty database and on randomly seeded ones built to break types (NULL wherever allowed, JSON `null`, arrays holding NULL, parents with no children) — and checks every value that comes back against the type sqlsure claimed. It also runs against [sqlc's](https://github.com/sqlc-dev/sqlc) end-to-end test suite, a corpus of real-world queries written by other people, and mutation-tests itself: deliberate bugs are injected into sqlsure, and the oracle must catch every one.

<!-- scorecard:start -->
<!-- scorecard:end -->

The full report, including every precision miss and every corpus query sqlsure does not type, is in [SCORECARD.md](./SCORECARD.md). Run it yourself with `npm run evals`.

## Setup

Requires TypeScript 7.1 (`typescript@beta`) and Node 22.15 or later.

```sh
npm install sqlsure pg
npm install -D typescript@beta
```

Point sqlsure at your schema in `tsconfig.json`: a `.sql` file, a folder of migrations (applied in path order; `-- migrate:down` and `-- +goose Down` sections are skipped), or a list of either.

```jsonc
{
  "compilerOptions": { "module": "nodenext", "strict": true },
  "contentMappers": [
    { "package": "sqlsure", "extensions": [".sql"], "options": { "schema": "./db/migrations" } }
  ]
}
```

Type-check with `--runExternalCode`, the flag that lets `tsc` run content mappers:

```sh
tsc --noEmit --runExternalCode
```

At run time, load sqlsure's hook so the import works in Node (it needs neither the schema nor a database: it only splits the file and rewrites parameters):

```sh
node --import sqlsure/register app.ts
```

In VS Code, install the TypeScript 7 extension (`TypeScriptTeam.native-preview`) and set `"js/ts.experimental.useTsgo": true`.

> **Security.** `--runExternalCode` lets `tsc` run the content mappers your `tsconfig.json` names. sqlsure runs your schema SQL inside its private in-process Postgres and nothing else; it never connects to a database. Only pass the flag for projects whose `contentMappers` you trust.

## Writing queries

```sql
-- name: listOrders :many
-- Lines right after the header become the function's JSDoc.
SELECT o.id, o.status, u.email
FROM orders o JOIN users u ON u.id = o.user_id
WHERE o.status = :status AND o.placed_on >= :since;

-- name: createUser :one
INSERT INTO users (email, display_name) VALUES (:email, :displayName?) RETURNING *;

-- name: deleteUser :execrows
DELETE FROM users WHERE id = :id;
```

| Mode | Returns |
| --- | --- |
| `:one` | `Row \| null` (the first row) |
| `:many` | `Row[]` |
| `:exec` | `void` |
| `:execrows` | `number` of affected rows |

Parameters are named, `:name`. A name used twice is one parameter. `:name?` accepts `null`. Casts (`::text`), strings, quoted identifiers, dollar-quoted bodies and comments are left alone. The `/* name: x :one */` header form from sqlc works too.

Every query function takes anything with node-postgres' `query(text, values)` — a `pg` `Client`, `Pool` or `PoolClient` — and carries `.sql` (the SQL sent, with `$1` placeholders) and `.paramNames`.

## What you get

<!-- features:start -->
<!-- features:end -->

Types follow what node-postgres returns with its default parsers: `bigint` and `numeric` are `string` (no silent precision loss), `date` and `timestamp[tz]` are `Date`, `bytea` is `Buffer`, `json`/`jsonb` is a `Json` value, enums are string-literal unions, and array elements are always `T | null` because Postgres arrays can hold NULL.

### How nullability is decided

A column is typed non-null only when sqlsure can **prove** it:

- it comes straight from a table column declared `NOT NULL` (Postgres reports each output column's origin), and
- that table is not on the nullable side of any `LEFT`/`RIGHT`/`FULL JOIN` anywhere in the statement, including inside subqueries, `LATERAL` and CTEs joined on that side, and
- the statement uses no `GROUPING SETS`/`ROLLUP`/`CUBE`;

or it is an expression that cannot be NULL: `count(…)`, `EXISTS`, `IS [NOT] NULL`, `row_number()` and other ranking windows, a non-null literal, or `COALESCE` with one of those.

Everything else is `| null`. That is deliberately conservative: a missing `| null` is a crash in production, an extra one is a `?.` you did not need. The scorecard measures both directions.

## Limitations (v0.1)

- **Postgres only**, with the default `pg` type parsers. Custom type parsers (`bigint` as `BigInt`, say) are not modeled yet.
- **Conservative spots**: columns of views, of a table joined to itself, of casts (`id::text`), of generated columns and of `UNION` output are typed nullable even when they cannot be NULL. The scorecard lists every such miss.
- **Two output columns with the same name are refused** (`SELECT a.id, b.id …`): node-postgres keeps only one of them, so no honest type exists. Rename one with `AS`.
- **No dynamic SQL**: optional filters and `IN` lists of varying length need a fixed shape (`= ANY(:ids)` works).
- **JSON arrays as parameters** must be passed pre-stringified: `pg` turns JS arrays into Postgres arrays.
- **Extensions**: those PGlite ships (`citext`, `hstore`, `ltree`, `pg_trgm`, `pgcrypto`, `uuid-ossp` and more) load when your schema creates them; others (PostGIS, pgvector) are not available yet.
- Requires the TypeScript 7.1 beta. The language server runs content mappers in VS Code through the TypeScript 7 extension.

## Performance

<!-- perf:start -->
<!-- perf:end -->

The first run on a machine boots Postgres from scratch (`initdb`); its data directory is then cached in your temp folder and later runs start from it.

## How the evals work

`npm run evals` needs a Postgres server (set `SQLSURE_EVAL_PG`, default `postgres://postgres@127.0.0.1:54329/postgres`). It runs six things:

1. **Oracle suites** (`evals/suites`): a realistic shop schema and a suite of traps written to fool nullability inference (outer joins inside subqueries, CTEs on the nullable side, `LATERAL`, `ROLLUP`, `UNION … NULL`, views, schema shadowing, upserts, JSON `null`). Each query runs on real Postgres and every value is checked; real Postgres' `PREPARE` must also agree with every column type. Hand-labeled ground truth (`expect.json`) measures precision.
2. **The sqlc corpus**: sqlc's end-to-end tests at a pinned commit, deduplicated. Breadth counts the queries real Postgres accepts that sqlsure types; every typed query then goes through the same oracle on seeded data.
3. **Feature fixtures** (`evals/features`): exact type assertions compiled by the real `tsc --runExternalCode`, plus a negative control that must fail.
4. **Diagnostics** (`evals/diagnostics`): broken files whose errors must land on the exact line and column.
5. **Mutation testing**: realistic bugs switched on inside sqlsure one at a time; the oracle must report violations for each.
6. **Performance**: `tsc` with 10, 100 and 1,000 queries, and per-call overhead over plain `pg`.

The ground-truth labels and the trap queries were written by sqlsure's authors, which is why the external corpus and the mutation tests exist: the first measures sqlsure on SQL it was not tuned for, the second proves the oracle can see the bugs it claims to rule out.

## License

MIT
