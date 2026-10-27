# Changelog

All notable changes to sqlsure are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). While the version is 0.x, a minor version may change generated types.

## [Unreleased]

### Added

- Two output columns with the same name are both returned, the second as `id_2` (then `id_3`, skipping names already in use), as in sqlc. They used to be refused. Rows now arrive from `pg` as arrays and get their keys from one rule shared by the types and the run time.
- Node 26 is tested in CI, alongside the oldest and latest supported Node 22 and 24.
- `.sql` imports outside Node's `--import` hook: `sqlsure/vite` for Vitest, Vite and Rollup, `sqlsure/esbuild` for esbuild and tsup, and `sqlsure/bun` for Bun. The example project runs a Vitest test and a Bun script, and the smoke test checks both.
- Schemas as people have them: a `pg_dump --schema-only` file loads as it is. Harmless psql meta-commands (`\restrict`, `\set`, `\connect`, …) are skipped; any other one is reported at its file and line. Roles the schema names but does not create (owners, grantees, policy roles) are created first, and the empty `search_path` pg_dump sets is reset before queries are checked.
- Migration folders of more tools: golang-migrate's `.down.sql` and Flyway's `U__` undo files are skipped, version numbers sort as numbers (`V2__` before `V10__`), and Flyway's repeatable `R__` files run last.
- pgvector, PostGIS, `pg_uuidv7`, `pg_hashids`, `pg_ivm`, `age`, `pgtap` and `pg_textsearch`: sqlsure loads them from PGlite's extension packages when the schema creates them. They are optional peer dependencies; a missing one is reported with the package and version to install.

### Changed

- **Breaking:** query functions call `db.query({ text, values, rowMode })` instead of `db.query(text, values)`. `pg`'s `Client`, `Pool` and `PoolClient` (and drivers that mirror them) accept both; a hand-written object with only `query(text, values)` needs the config form.
- More columns are proven non-null, so some `| null` disappear from generated types. Column references are traced to the FROM item they name, so one side of a self-join is no longer made nullable by the other. Casts, arithmetic, comparisons, `||`, `AND`/`OR`/`NOT`, `GREATEST`/`LEAST`, `IS DISTINCT FROM` and common built-in functions of non-null columns are non-null, and so is every `ARRAY[…]` constructor. Columns merged by `USING` and `NATURAL` follow their side of the join. A function, operator or cast the schema defines under a built-in's name is not trusted.
- View columns are proven from the view's definition, and generated columns from their expression, instead of always being nullable.

### Fixed

- A schema error in a dbmate file with text before `-- migrate:up` pointed at the wrong line.
- `RETURNING` from a table with a `DO INSTEAD` rule, or from a view, was typed by the table's NOT NULL constraints, but the rule's action (or an `INSTEAD OF` trigger) decides what comes back. Such columns are now nullable.
- Expressions in `RETURNING` (`RETURNING 1 AS one`, `… IS NULL`, `now()`) were always typed nullable: the parser moved `RETURNING` to a new field in Postgres 18's grammar, and sqlsure still read the old one.
- `MERGE … RETURNING` typed the source's columns non-null, but rows from `WHEN NOT MATCHED BY SOURCE` have no source row, so Postgres returns NULL for them.
- An expression grouped by `ROLLUP`, `CUBE` or `GROUPING SETS` (a literal, `COALESCE(…)`, `x IS NULL`, or a cast of one) was typed non-null, but Postgres returns NULL for it in subtotal rows. Grouping keys are now matched the way Postgres matches them: by output name, by position, and ignoring column qualifiers and casts.

## [0.1.0] - 2026-10-25

First release.

### Added

- TypeScript 7.1 content mapper: `import { getUser } from "./users.sql"` is typed by `tsc --runExternalCode`, with types from an in-process Postgres (PGlite) that holds your schema.
- Schema from a `.sql` file, a folder of migrations, or a list of either; down sections of dbmate, goose and similar tools are skipped. Contrib extensions PGlite ships load on `CREATE EXTENSION`.
- Query modes `:one`, `:many`, `:exec` and `:execrows`; named `:params` and nullable `:params?`; sqlc-style `/* name: */` headers; JSDoc from the comment lines under a header.
- Provable nullability: NOT NULL columns stay non-null unless an outer join, grouping set or set operation can make them NULL; `count`, `EXISTS`, ranking windows, literals and `COALESCE` of those are non-null.
- Postgres errors reported at the exact line and column in the `.sql` file.
- `sqlsure/register`: a Node module hook that loads `.sql` files at run time, with no schema and no database.
- Supports Node 22.22+ and 24.10+. Older versions start TypeScript 7's compiler with an empty environment, which breaks every content mapper.
- Eval suite: a soundness oracle against real Postgres and `pg`, precision against hand-labeled ground truth, breadth on sqlc's end-to-end corpus, mutation testing, diagnostics positions, and a smoke test of the packed tarball.

[Unreleased]: https://github.com/AfshinJalili/sqlsure/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/AfshinJalili/sqlsure/releases/tag/v0.1.0
