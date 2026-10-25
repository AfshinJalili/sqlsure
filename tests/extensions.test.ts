// Extensions PGlite publishes as separate packages load when the schema creates them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine, extensionsIn } from "../src/engine.ts";
import { analyzeFile } from "../src/analyze.ts";
import { render } from "../src/pgtypes.ts";

test("pgvector and PostGIS columns and parameters are typed", async () => {
  const schema = `create extension if not exists vector;
    create extension postgis;
    create table items (id int primary key, embedding vector(3) not null, location geometry(Point, 4326));`;
  assert.deepEqual(extensionsIn(schema), ["postgis", "vector"]);
  const e = await Engine.create(extensionsIn(schema));
  try {
    await e.loadSchema(schema);
    const r = await analyzeFile(
      `-- name: nearest :many
SELECT id, embedding, embedding <-> :query AS distance, location, ST_AsText(location) AS wkt
FROM items ORDER BY embedding <-> :query LIMIT 5;
`,
      e,
    );
    assert.deepEqual(r.problems, []);
    const [q] = r.queries;
    const columns = Object.fromEntries(q.columns.map((c) => [c.name, `${render(c.type)}${c.nullable ? " | null" : ""}`]));
    assert.deepEqual(columns, {
      id: "number",
      embedding: "string",
      distance: "number | null",
      location: "string | null",
      wkt: "string | null",
    });
    assert.deepEqual(
      q.params.map((p) => `${p.name}: ${render(p.type)}`),
      ["query: string"],
    );
  } finally {
    await e.close();
  }
});

test("a packaged extension that is not installed names the package to install", async () => {
  await assert.rejects(Engine.create(["age"]), /extension "age".*npm install -D @electric-sql\/pglite-age@0\.0\.12/);
});
