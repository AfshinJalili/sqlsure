# Changelog

All notable changes to sqlsure are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). While the version is 0.x, a minor version may change generated types.

## [Unreleased]

### Changed

- More columns are proven non-null, so some `| null` disappear from generated types. Column references are traced to the FROM item they name, so one side of a self-join is no longer made nullable by the other. Casts, arithmetic, comparisons, `||`, `AND`/`OR`/`NOT`, `GREATEST`/`LEAST`, `IS DISTINCT FROM` and common built-in functions of non-null columns are non-null. Columns merged by `USING` and `NATURAL` follow their side of the join. A function, operator or cast the schema defines under a built-in's name is not trusted.
- View columns are proven from the view's definition, and generated columns from their expression, instead of always being nullable.

### Fixed

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
