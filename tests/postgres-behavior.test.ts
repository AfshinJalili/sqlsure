// Facts about Postgres that sqlsure's nullability rules lean on. If a Postgres upgrade changes
// one, this fails before any type silently becomes wrong.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../src/engine.ts";

const schema = `
  create table a (id int primary key, label text not null);
  create table b (id int primary key, a_id int, label text not null);
  create view v as select id, label from a;
  create domain pos as int check (value > 0);
  create table d (x pos not null);`;

test("Postgres facts sqlsure relies on", async (t) => {
  const e = await Engine.create();
  await e.loadSchema(schema);
  const origin = async (sql: string) => (await e.describe(sql)).fields!.map((f) => [f.tableID, f.columnID]);
  await t.test("no column origin through set operations", async () => {
    for (const sql of [
      "select label from a union all select label from b",
      "select u.label from (select label from a union all select null) u",
      "select label from a intersect select label from b",
      "select label from a except select label from b",
    ])
      assert.deepEqual(await origin(sql), [[0, 0]], sql);
  });
  await t.test("origins pass through CTEs and FROM subqueries", async () => {
    const [[table]] = await origin("with x as (select label from b) select label from x");
    assert.notEqual(table, 0);
    const [[table2]] = await origin("select s.label from (select label from b) s");
    assert.notEqual(table2, 0);
  });
  await t.test("computed expressions have no origin", async () => {
    assert.deepEqual(await origin("select label || '' as l from a"), [[0, 0]]);
    assert.deepEqual(await origin("select max(id) as m from a"), [[0, 0]]);
  });
  await t.test("a view column's origin is the view, which is never NOT NULL", async () => {
    const [[table, column]] = await origin("select label from v");
    assert.notEqual(table, 0);
    assert.equal(await e.isNotNull(table, column), false);
  });
  await t.test("a domain is described as its base type", async () => {
    const d = await e.describe("select x from d");
    assert.equal(d.fields![0].dataTypeID, 23);
  });
  await e.close();
});
