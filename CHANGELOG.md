# Changelog

All notable changes to sqlsure are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). While the version is 0.x, a minor version may change generated types.

## [Unreleased]

## [0.1.0] - 2026-10-25

First release.

### Added

- TypeScript 7.1 content mapper: `import { getUser } from "./users.sql"` is typed by `tsc --runExternalCode`, with types from an in-process Postgres (PGlite) that holds your schema.
- Schema from a `.sql` file, a folder of migrations, or a list of either; down sections of dbmate, goose and similar tools are skipped. Contrib extensions PGlite ships load on `CREATE EXTENSION`.
- Query modes `:one`, `:many`, `:exec` and `:execrows`; named `:params` and nullable `:params?`; sqlc-style `/* name: */` headers; JSDoc from the comment lines under a header.
- Provable nullability: NOT NULL columns stay non-null unless an outer join, grouping set or set operation can make them NULL; `count`, `EXISTS`, ranking windows, literals and `COALESCE` of those are non-null.
- Postgres errors reported at the exact line and column in the `.sql` file.
- `sqlsure/register`: a Node module hook that loads `.sql` files at run time, with no schema and no database.
- Eval suite: a soundness oracle against real Postgres and `pg`, precision against hand-labeled ground truth, breadth on sqlc's end-to-end corpus, mutation testing, diagnostics positions, and a smoke test of the packed tarball.

[Unreleased]: https://github.com/AfshinJalili/sqlsure/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/AfshinJalili/sqlsure/releases/tag/v0.1.0
