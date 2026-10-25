// Nullability decisions that depend on how output positions line up with the select list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../src/engine.ts";
import { analyzeFile } from "../src/analyze.ts";

test("expanding a composite with (x).* does not shift expression facts onto other columns", async () => {
  const e = await Engine.create();
  try {
    await e.loadSchema(`create type pair as (a int, b int);
      create table t (id int primary key, p pair);`);
    const r = await analyzeFile(
      `-- name: star :one
SELECT (p).*, 1 AS one FROM t;
-- name: fnStar :one
SELECT (t.p).*, count(*) AS n FROM t GROUP BY t.p;
-- name: between :one
SELECT 1 AS first, t.*, (p).*, now() AS last FROM t;
`,
      e,
    );
    assert.deepEqual(r.problems, []);
    const nullability = Object.fromEntries(
      r.queries.map((q) => [q.name, Object.fromEntries(q.columns.map((c) => [c.name, c.nullable]))]),
    );
    assert.deepEqual(nullability.star, { a: true, b: true, one: false });
    assert.deepEqual(nullability.fnStar, { a: true, b: true, n: false });
    assert.deepEqual(nullability.between, { first: false, id: false, p: true, a: true, b: true, last: false });
  } finally {
    await e.close();
  }
});

test("grouping sets NULL out grouped expressions, matched the way Postgres matches them", async () => {
  const e = await Engine.create();
  try {
    await e.loadSchema("create table a (id int primary key, label text not null, n int not null);");
    const r = await analyzeFile(
      `-- name: byAlias :many
SELECT 1 AS one, coalesce(n, 0) AS c, (label IS NULL) AS t, count(*) AS cnt FROM a GROUP BY ROLLUP (one, c, t);
-- name: byPosition :many
SELECT 'all' AS scope, count(*) AS cnt FROM a GROUP BY ROLLUP (1);
-- name: qualified :many
SELECT coalesce(a.n, 0) AS v FROM a GROUP BY CUBE (coalesce(n, 0));
-- name: castConstant :many
SELECT 1::int AS v FROM a GROUP BY ROLLUP ('1'::int);
-- name: inside :many
SELECT (label IS NULL)::int AS flag, coalesce(label IS NULL, true) AS safe FROM a GROUP BY GROUPING SETS ((label IS NULL), ());
-- name: ungrouped :many
SELECT 'all' AS scope, label FROM a GROUP BY CUBE (label);
-- name: plainGroupBy :many
SELECT coalesce(n, 0) AS c FROM a GROUP BY c;
`,
      e,
    );
    assert.deepEqual(r.problems, []);
    const nullability = Object.fromEntries(
      r.queries.map((q) => [q.name, Object.fromEntries(q.columns.map((c) => [c.name, c.nullable]))]),
    );
    assert.deepEqual(nullability.byAlias, { one: true, c: true, t: true, cnt: false });
    assert.deepEqual(nullability.byPosition, { scope: true, cnt: false });
    assert.deepEqual(nullability.qualified, { v: true });
    assert.deepEqual(nullability.castConstant, { v: true });
    assert.deepEqual(nullability.inside, { flag: true, safe: false });
    assert.deepEqual(nullability.ungrouped, { scope: false, label: true });
    assert.deepEqual(nullability.plainGroupBy, { c: false });
  } finally {
    await e.close();
  }
});
