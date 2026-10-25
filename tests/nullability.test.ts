// Nullability decisions, checked through the same path tsc takes: analyzeFile over a schema.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../src/engine.ts";
import { analyzeFile } from "../src/analyze.ts";

/** `{ query: { column: nullable } }` for every query in `file`, which must analyze without problems. */
async function nullability(schema: string, file: string): Promise<Record<string, Record<string, boolean>>> {
  const e = await Engine.create();
  try {
    await e.loadSchema(schema);
    const r = await analyzeFile(file, e);
    assert.deepEqual(r.problems, []);
    return Object.fromEntries(r.queries.map((q) => [q.name, Object.fromEntries(q.columns.map((c) => [c.name, c.nullable]))]));
  } finally {
    await e.close();
  }
}

test("expanding a composite with (x).* does not shift expression facts onto other columns", async () => {
  const n = await nullability(
    `create type pair as (a int, b int);
     create table t (id int primary key, p pair);`,
    `-- name: star :one
SELECT (p).*, 1 AS one FROM t;
-- name: fnStar :one
SELECT (t.p).*, count(*) AS n FROM t GROUP BY t.p;
-- name: between :one
SELECT 1 AS first, t.*, (p).*, now() AS last FROM t;
`,
  );
  assert.deepEqual(n.star, { a: true, b: true, one: false });
  assert.deepEqual(n.fnStar, { a: true, b: true, n: false });
  assert.deepEqual(n.between, { first: false, id: false, p: true, a: true, b: true, last: false });
});

test("grouping sets NULL out grouped expressions, matched the way Postgres matches them", async () => {
  const n = await nullability(
    "create table a (id int primary key, label text not null, n int not null);",
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
  );
  assert.deepEqual(n.byAlias, { one: true, c: true, t: true, cnt: false });
  assert.deepEqual(n.byPosition, { scope: true, cnt: false });
  assert.deepEqual(n.qualified, { v: true });
  assert.deepEqual(n.castConstant, { v: true });
  assert.deepEqual(n.inside, { flag: true, safe: false });
  assert.deepEqual(n.ungrouped, { scope: false, label: true });
  assert.deepEqual(n.plainGroupBy, { c: false });
});

test("MERGE ... WHEN NOT MATCHED BY SOURCE makes the source nullable in RETURNING", async () => {
  const n = await nullability(
    `create table t (id int primary key, label text not null);
     create table s (id int primary key, label text not null);`,
    `-- name: bySource :many
MERGE INTO t USING s ON s.id = t.id
WHEN MATCHED THEN UPDATE SET label = s.label
WHEN NOT MATCHED BY SOURCE THEN DELETE
RETURNING t.id AS t_id, s.label AS s_label;
-- name: byTarget :many
MERGE INTO t USING s ON s.id = t.id
WHEN NOT MATCHED THEN INSERT VALUES (s.id, s.label)
RETURNING t.id AS t_id, s.label AS s_label;
`,
  );
  assert.deepEqual(n.bySource, { t_id: false, s_label: true });
  assert.deepEqual(n.byTarget, { t_id: false, s_label: false });
});

test("expressions in RETURNING are proven like expressions in a select list", async () => {
  const n = await nullability(
    "create table a (id int primary key, label text not null);",
    `-- name: ins :one
INSERT INTO a VALUES (1, 'x') RETURNING id, 1 AS one, (label IS NULL) AS t, nullif(label, '') AS maybe;
-- name: del :one
DELETE FROM a RETURNING 'gone' AS what;
`,
  );
  assert.deepEqual(n.ins, { id: false, one: false, t: false, maybe: true });
  assert.deepEqual(n.del, { what: false });
});

test("RETURNING from a table with a DO INSTEAD rule is not bound by the table's NOT NULL", async () => {
  const n = await nullability(
    `create table t (id int primary key, label text not null);
     create table log (id int, label text);
     create table plain (id int primary key, label text not null);
     create rule redirect as on insert to t do instead insert into log values (new.id, null) returning log.id, log.label;`,
    `-- name: redirected :one
INSERT INTO t VALUES (1, 'x') RETURNING id, label;
-- name: plain :one
INSERT INTO plain VALUES (1, 'x') RETURNING id, label;
`,
  );
  assert.deepEqual(n.redirected, { id: true, label: true });
  assert.deepEqual(n.plain, { id: false, label: false });
});

test("column references are traced to the FROM item they name", async () => {
  const n = await nullability(
    `create table a (id int primary key, label text not null, n int not null);
     create table b (id int primary key, a_id int, label text not null);`,
    `-- name: selfJoin :many
SELECT child.id, child.label, parent.label AS parent_label FROM a child LEFT JOIN a parent ON parent.id = child.n;
-- name: expressions :many
SELECT a.id::text AS id_text, a.n * 2 + 1 AS calc, lower(a.label) AS l, b.id::text AS b_text, b.a_id + 1 AS b_calc
FROM a LEFT JOIN b ON b.a_id = a.id;
-- name: merged :many
SELECT x.id, x.label FROM (SELECT id, label FROM a NATURAL FULL JOIN b) x;
-- name: naturalFull :many
SELECT id, label FROM a NATURAL FULL JOIN b;
-- name: usingLeft :many
SELECT id FROM a LEFT JOIN b USING (id);
-- name: usingRight :many
SELECT id FROM a RIGHT JOIN b USING (id);
-- name: usingFullNullable :many
SELECT a_id FROM b b1 FULL JOIN b b2 USING (a_id);
-- name: subquery :many
SELECT s.id FROM (SELECT b.id FROM a LEFT JOIN b ON b.a_id = a.id) s;
`,
  );
  assert.deepEqual(n.selfJoin, { id: false, label: false, parent_label: true });
  assert.deepEqual(n.expressions, { id_text: false, calc: false, l: false, b_text: true, b_calc: true });
  assert.deepEqual(n.merged, { id: true, label: true }, "through a subquery, sqlsure does not trace merged columns");
  assert.deepEqual(n.naturalFull, { id: false, label: false });
  assert.deepEqual(n.usingLeft, { id: false });
  assert.deepEqual(n.usingRight, { id: false });
  assert.deepEqual(n.usingFullNullable, { a_id: true });
  assert.deepEqual(n.subquery, { id: true });
});

test("a schema's own function, operator or cast is not trusted like the built-in it shadows", async () => {
  const n = await nullability(
    `create type mood as enum ('happy', 'sad');
     create table a (id int primary key, label text not null, n int not null);
     create function lower(int) returns text language sql as 'select null::text';
     create function text_plus_int(text, int) returns text language sql as 'select null::text';
     create operator + (leftarg = text, rightarg = int, function = text_plus_int);
     create function int_to_mood(int) returns mood language sql as 'select null::mood';
     create cast (int as mood) with function int_to_mood(int);`,
    `-- name: shadowed :many
SELECT lower(n) AS l, label + n AS plus, n::mood AS m, pg_catalog.lower(label) AS builtin, n * 2 AS times FROM a;
`,
  );
  assert.deepEqual(n.shadowed, { l: true, plus: true, m: true, builtin: false, times: false });
});

test("view and generated columns are proven from their definitions", async () => {
  const n = await nullability(
    `create table a (id int primary key, label text not null);
     create table b (id int primary key, a_id int, label text not null);
     create view av as select id, label from a;
     create view bv as select b.id, a.label, count(*) over () as cnt from b left join a on a.id = b.a_id;
     create view nested as select id, label || '!' as bang from av;
     create view unioned as select id from a union all select null;
     create materialized view mv as select id from a;
     create table g (id int primary key, x int, twice int generated always as (id * 2) stored, maybe int generated always as (x + 1) stored);
     create view loud as select id, label from b;
     create function loud_ins() returns trigger language plpgsql as $$ begin new.id := null; return new; end $$;
     create trigger loud_ins instead of insert on loud for each row execute function loud_ins();`,
    `-- name: views :many
SELECT av.id, av.label, bv.label AS b_label, bv.cnt, nested.bang FROM av JOIN bv ON bv.id = av.id JOIN nested ON nested.id = av.id;
-- name: nullableSide :many
SELECT a.id, av.label FROM a LEFT JOIN av ON av.id = a.id;
-- name: others :many
SELECT unioned.id AS u, mv.id AS m FROM unioned, mv;
-- name: generated :many
SELECT twice, maybe FROM g;
-- name: throughTrigger :one
INSERT INTO loud (id, label) VALUES (1, 'x') RETURNING id, label;
`,
  );
  assert.deepEqual(n.views, { id: false, label: false, b_label: true, cnt: false, bang: false });
  assert.deepEqual(n.nullableSide, { id: false, label: true });
  assert.deepEqual(n.others, { u: true, m: true });
  assert.deepEqual(n.generated, { twice: false, maybe: true });
  assert.deepEqual(n.throughTrigger, { id: true, label: true });
});
