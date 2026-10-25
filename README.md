# sqlsure

[![npm](https://img.shields.io/npm/v/sqlsure)](https://www.npmjs.com/package/sqlsure)
[![license](https://img.shields.io/npm/l/sqlsure)](./LICENSE)
[![node](https://img.shields.io/node/v/sqlsure)](https://nodejs.org)

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

Drop a column from your schema and every query that uses it fails `tsc`, with the error at the exact line in the `.sql` file. There is no generator to run, no generated files to commit, and nothing to forget to regenerate.

sqlsure is a [TypeScript 7.1 content mapper](https://github.com/microsoft/typescript-go/pull/4712): `tsc` hands it each `.sql` file and it returns the types. A real Postgres (compiled to WebAssembly, running in-process, holding only your schema) checks every query, so any SQL Postgres accepts works, and every error message is Postgres' own.

- [Setup](#setup)
- [Writing queries](#writing-queries)
- [Types](#types)
- [Why trust the types?](#why-trust-the-types)
- [Limitations](#limitations)
- [Performance](#performance)

## Setup

Requires TypeScript 7.1 (`typescript@beta`) and Node 22.22+, 24.10+ or 26.

```sh
npm install sqlsure pg
npm install -D typescript@beta
```

Point sqlsure at your schema in `tsconfig.json`. The schema can be a `.sql` file, a folder of migrations (applied in path order; `-- migrate:down` and `-- +goose Down` sections are skipped), or a list of either.

```jsonc
{
  "compilerOptions": { "module": "nodenext", "strict": true },
  "contentMappers": [
    { "package": "sqlsure", "extensions": [".sql"], "options": { "schema": "./db/migrations" } }
  ]
}
```

**Extensions.** Postgres contrib extensions that PGlite ships (`citext`, `hstore`, `ltree`, `pg_trgm`, `pgcrypto`, `uuid-ossp` and more) load when your schema runs `CREATE EXTENSION`. pgvector, PostGIS, `pg_uuidv7`, `pg_hashids`, `pg_ivm`, `age`, `pgtap` and `pg_textsearch` come as separate PGlite packages. Install the one your schema needs, for example `npm install -D @electric-sql/pglite-pgvector`; if it is missing, sqlsure's error names the package and version.

Type-check with `--runExternalCode`, the flag that lets `tsc` run content mappers:

```sh
tsc --noEmit --runExternalCode
```

At run time, load sqlsure's hook so the import works in Node. The hook needs no schema and no database; it only splits the file and rewrites parameters.

```sh
node --import sqlsure/register app.ts
```

Other tools load `.sql` files the same way:

| Tool | Setup |
| --- | --- |
| Vitest, Vite, Rollup | `import sqlsure from "sqlsure/vite"` and `plugins: [sqlsure()]` in `vitest.config.ts` or `vite.config.ts` |
| esbuild, tsup | `import sqlsure from "sqlsure/esbuild"` and `plugins: [sqlsure()]` |
| Bun | `bun --preload sqlsure/bun app.ts`, or `preload = ["sqlsure/bun"]` in `bunfig.toml` |

In VS Code, install the TypeScript 7 extension (`TypeScriptTeam.native-preview`) and set `"js/ts.experimental.useTsgo": true`.

A complete project is in [`examples/basic`](./examples/basic).

> **Troubleshooting.** `error TS18069: The content mapper 'sqlsure' failed to transform this file. The content mapper process failed while handling the project request` usually means Node is too old: before 22.22 and 24.10, TypeScript 7's `tsc` launcher starts the compiler with an empty environment, so it cannot find `node` to run any content mapper. Upgrade Node.

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

Each query starts with a `-- name: <name> :<mode>` line (sqlc's `/* name: getUser :one */` form works too) and holds one statement. The name becomes the export.

| Mode | Returns |
| --- | --- |
| `:one` | `Row \| null` (the first row) |
| `:many` | `Row[]` |
| `:exec` | `void` |
| `:execrows` | `number` of affected rows |

**Columns** become the row's keys. Two columns with the same name (`SELECT a.id, b.id`) are both kept: the second is `id_2`, as in sqlc.

**Parameters** are named: `:name`. A name used twice is one parameter, and `:name?` also accepts `null`. Casts (`::text`), strings, quoted identifiers, dollar-quoted bodies and comments are left alone. In an array subscript, a colon after a value is a slice (`arr[1:n]`); `ARRAY[:a, :b]` and `arr[:i]` are parameters.

**Calling a query.** Every query function takes anything with node-postgres' `query(config)` method (a `pg` `Client`, `Pool` or `PoolClient`, or a driver that mirrors it, such as `@neondatabase/serverless`) and its parameters as an object. Each function also carries `.sql` (the SQL it sends, with `$1` placeholders), `.paramNames` and `.mode`. The file also exports a `GetUserParams` and `GetUserRow` type for each query.

```ts
import { listOrders, deleteUser, type ListOrdersRow } from "./orders.sql";

const orders: ListOrdersRow[] = await listOrders(pool, { status: "paid", since: new Date("2026-01-01") });

const client = await pool.connect();
await client.query("BEGIN");
const deleted = await deleteUser(client, { id: 7 }); // number of rows deleted
await client.query("COMMIT");
client.release();
```

## Types

Types follow what node-postgres returns with its default parsers:

| Postgres | TypeScript |
| --- | --- |
| `int2`, `int4`, `float4`, `float8`, `oid` | `number` |
| `int8`, `numeric`, `money` | `string` (no silent precision loss) |
| `text`, `varchar`, `uuid`, `time`, `inet`, … | `string` |
| `date`, `timestamp`, `timestamptz` | `Date` (but see below for `'infinity'`) |
| `bool` | `boolean` |
| `bytea` | `Buffer` |
| `json`, `jsonb` | `Json` |
| `interval` | `Interval` (`{ days?: number; hours?: number; … }`) |
| enums | string-literal unions, such as `"draft" \| "live"` |
| arrays | `(T \| null)[]`, because Postgres arrays can hold NULL |
| composites, ranges, domains and other types | `string` (the raw text pg returns) |

One known gap: a date or timestamp holding `'infinity'` or `'-infinity'` comes back from `pg` as the number `Infinity` or `-Infinity`, not a `Date`. sqlsure still types it `Date`. If your data uses infinite dates, check with `typeof value === "number"`.

Parameters accept what `pg` serializes: an `int8` parameter takes `number | string | bigint`, a date takes `Date | string`, a JSON parameter takes an object or a pre-stringified JSON value.

### How nullability is decided

A column is typed non-null only when sqlsure can **prove** it:

- **A column reference** is traced to the table it names, by alias, the way Postgres resolves it. It is non-null when that column is `NOT NULL` and no `LEFT`/`RIGHT`/`FULL JOIN` above it can NULL-extend it. So in `categories child LEFT JOIN categories parent`, `child.name` is non-null and `parent.name` is not. `MERGE … WHEN NOT MATCHED BY SOURCE` counts as an outer join on the source.
- **A view column** is proven from the view's definition, and **a generated column** from its expression.
- **A column merged by `USING` or `NATURAL`** follows its side of the join; after a `FULL JOIN`, both sides must be non-null.
- **An expression** is non-null when it cannot be NULL: `count(…)`, `EXISTS`, `IS [NOT] NULL`, `IS DISTINCT FROM`, ranking windows, non-null literals, `ARRAY[…]` constructors, `COALESCE`/`GREATEST`/`LEAST` with one non-null argument, and casts, `AND`/`OR`/`NOT`, arithmetic, comparison, `||` and common built-in functions (`lower`, `length`, `round`, `date_trunc`, `concat`, …) of non-null values. If your schema defines its own function, operator or cast with the same name, sqlsure no longer trusts that name.
- **Columns read through a subquery or CTE** use the origin Postgres reports. They are non-null only when that table is on the nullable side of no outer join anywhere in the statement.

With `GROUPING SETS`, `ROLLUP` or `CUBE`, any grouped expression can be NULL in subtotal rows, matched the way Postgres matches grouping keys. `UNION`/`INTERSECT`/`EXCEPT` output is nullable. `RETURNING` from a view or from a table with a `DO INSTEAD` rule is nullable, because a trigger or rule decides what comes back.

Everything else is `| null`. That is deliberately conservative: a missing `| null` is a crash in production, an extra one is a `?.` you did not need. The scorecard measures both directions.

<!-- features:start -->
|  | Feature |
| --- | --- |
| ✅ | Aggregates and windows: count/row_number/EXISTS/COALESCE(…, literal) are non-null; sum/max/lag are nullable |
| ✅ | Arrays (elements may be NULL); arrays of enums come back as text, typed string |
| ✅ | CTEs and set operations (UNION output is conservatively nullable) |
| ✅ | Enums become string-literal unions, for columns and parameters |
| ✅ | Joins: INNER keeps NOT NULL, LEFT/RIGHT/FULL/LATERAL make the outer side nullable, alias by alias in a self-join |
| ✅ | json/jsonb as a Json value; JSON parameters take objects or pre-stringified JSON |
| ✅ | Every query function carries its final SQL and parameter order |
| ✅ | Schema-qualified tables, quoted identifiers, views (columns proven from the view's definition), queries named like sqlsure types |
| ✅ | Named :params (reused names are one parameter); casts, strings, dollar quotes and comments are left alone |
| ✅ | Two columns with the same name are both returned, the second as name_2 (as in sqlc) |
| ✅ | Scalar types as node-postgres returns them (int8/numeric as string, dates as Date, bytea as Buffer, interval, point) |
| ✅ | SELECT with NOT NULL and nullable columns; :one returns Row | null; sqlc-style /* name: */ headers |
| ✅ | INSERT/UPDATE … RETURNING, :exec (void) and :execrows (affected row count) |
<!-- features:end -->

Each row above is a fixture in [`evals/features`](./evals/features) whose exact types are asserted through the real `tsc`.

## Why trust the types?

Typed-SQL tools usually ask you to take their word for it. sqlsure ships the evidence. Its eval suite runs every query on a **real Postgres through the real `pg` driver**, on an empty database and on randomly seeded ones built to break types (NULL wherever allowed, JSON `null`, arrays holding NULL, parents with no children), and checks every returned value against the type sqlsure claimed. It also runs against [sqlc's](https://github.com/sqlc-dev/sqlc) end-to-end test suite, a corpus of real-world queries written by other people. And it mutation-tests itself: deliberate bugs are switched on inside sqlsure, and the oracle must catch every one.

<!-- scorecard:start -->
|  | Check | Result | Threshold |
| --- | --- | --- | --- |
| ✅ | Soundness: values contradicting their type | 0 | = 0 |
| ✅ | Precision: truly non-null columns typed non-null | 100.0% (138/138) | ≥ 85% |
| ✅ | Breadth: real-world queries typed (sqlc corpus) | 100.0% (548/548) | ≥ 90% |
| ✅ | Feature fixtures (exact types through tsc) | 100% | = 100% |
| ✅ | Negative control fails | yes | yes |
| ✅ | Diagnostics at exact line:column | 100% | = 100% |
| ✅ | Mutations killed by the oracle | 100% (11/11) | = 100% |
<!-- scorecard:end -->

CI runs all of it on every push. The full report, including every precision miss and every corpus query sqlsure does not type, is in [SCORECARD.md](./SCORECARD.md); [CONTRIBUTING.md](./CONTRIBUTING.md) explains how each check works and how to run it.

## Limitations

- **Postgres only**, with the default `pg` type parsers. Custom type parsers (`bigint` as `BigInt`, say) are not modeled yet.
- **Conservative spots**: `UNION` output, materialized view columns, merged join columns read through a subquery, and functions outside the built-in list are typed nullable even when they cannot be NULL. The scorecard lists every miss on its test queries.
- **No dynamic SQL**: optional filters and `IN` lists of varying length need a fixed shape (`= ANY(:ids)` works).
- **JSON arrays as parameters** must be passed pre-stringified, because `pg` turns JS arrays into Postgres arrays.
- **Extensions** that PGlite does not provide (contrib or packaged, see [Setup](#setup)) cannot be loaded, so a schema that creates one fails to load. Extension types such as `vector` and `geometry` are typed `string`, the text `pg` returns for them.
- **TypeScript 7.1 beta** is required: content mappers are new in it. In editors, the TypeScript 7 language server runs them.

## Performance

<!-- perf:start -->
| Queries | tsc, warm | tsc, first run on a machine | plain tsc (no .sql) | per query |
| --- | --- | --- | --- | --- |
| 10 | 1.01 s | 2.96 s | 0.13 s | 88.5 ms |
| 100 | 1.13 s | 3.01 s | 0.14 s | 10.0 ms |
| 1000 | 1.82 s | 3.64 s | 0.11 s | 1.7 ms |

Run time: 2.4 µs added per query call over calling `pg` directly (242 µs raw round trip to a local Postgres, median difference over 9 alternating trials of 3000 calls).
<!-- perf:end -->

The first run on a machine boots Postgres from scratch (`initdb`); its data directory is then cached in your temp folder (`SQLSURE_CACHE_DIR` to move it), and later runs start from it.

## Contributing and releases

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development and the eval suite, [CHANGELOG.md](./CHANGELOG.md) for what changed, and [RELEASING.md](./RELEASING.md) for how versions are published.

## License

[MIT](./LICENSE)
