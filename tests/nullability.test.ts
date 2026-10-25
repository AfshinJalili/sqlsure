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
