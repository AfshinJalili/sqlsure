// Schemas as people actually have them: pg_dump output, migration folders of common tools.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeEngines, Project } from "../src/project.ts";
import { readSchema, resolveSchemaFiles } from "../src/schema.ts";

after(closeEngines);

const FIXTURES = new URL("./fixtures/", import.meta.url).pathname;
const USERS = "-- name: users :many\nSELECT id, email, m FROM users;\n";

/** A temporary project folder holding `files`; returns the tsconfig path and a cleanup. */
function folder(files: Record<string, string>): { config: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "sqlsure-schema-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return { config: join(dir, "tsconfig.json"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

async function problemsAndColumns(schema: string | string[], config: string, queries: string) {
  const r = await new Project({ schema }, config).analyze(queries);
  return { problems: r.problems.map((p) => p.message), columns: r.queries.map((q) => q.columns.map((c) => `${c.name}${c.nullable ? "?" : ""}`).join(" ")) };
}

test("a pg_dump --schema-only file loads: psql meta-commands, an emptied search_path, roles", async () => {
  const r = await problemsAndColumns(join(FIXTURES, "pg_dump.sql"), join(FIXTURES, "tsconfig.json"), USERS);
  assert.deepEqual(r, { problems: [], columns: ["id email m?"] });
});

test("roles the schema grants to or hands ownership to are created; roles it creates itself are left to it", async () => {
  const f = folder({
    "schema.sql": `CREATE ROLE anon NOLOGIN;
CREATE TABLE users (id int PRIMARY KEY, email text NOT NULL, m text);
ALTER TABLE users OWNER TO "App Owner";
GRANT SELECT ON users TO anon, authenticated;
GRANT authenticated TO service_role;
CREATE SCHEMA app AUTHORIZATION app_owner;
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA app GRANT SELECT ON TABLES TO readers;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY own ON users TO authenticated USING (true);
REVOKE ALL ON users FROM PUBLIC;
`,
  });
  try {
    assert.deepEqual(await problemsAndColumns("schema.sql", f.config, USERS), { problems: [], columns: ["id email m?"] });
  } finally {
    f.done();
  }
});

test("psql meta-commands: harmless ones are skipped, others are reported at their line, text inside bodies is left alone", async () => {
  const f = folder({
    "ok.sql": `\\set ON_ERROR_STOP on
CREATE TABLE users (id int PRIMARY KEY, email text NOT NULL, m text);
CREATE FUNCTION digits(t text) RETURNS text LANGUAGE sql AS $$
SELECT regexp_replace(t, '
\\D', '', 'g')
$$;
`,
    "include.sql": "CREATE TABLE users (id int PRIMARY KEY, email text NOT NULL, m text);\n\\i other.sql\n",
  });
  try {
    assert.deepEqual(await problemsAndColumns("ok.sql", f.config, USERS), { problems: [], columns: ["id email m?"] });
    const bad = await problemsAndColumns("include.sql", f.config, USERS);
    assert.equal(bad.problems.length, 1);
    assert.match(bad.problems[0], /include\.sql:2: psql meta-command \\i/);
  } finally {
    f.done();
  }
});

test("migration folders: golang-migrate down files are skipped, unpadded versions sort by number, Flyway undo and repeatable files", async () => {
  const f = folder({
    "migrate/000001_users.up.sql": "CREATE TABLE users (id int PRIMARY KEY, email text NOT NULL);\n",
    "migrate/000001_users.down.sql": "DROP TABLE users;\n",
    "migrate/000002_mood.up.sql": "ALTER TABLE users ADD COLUMN m text;\n",
    "migrate/000002_mood.down.sql": "ALTER TABLE users DROP COLUMN m;\n",
    "flyway/V1__users.sql": "CREATE TABLE users (id int PRIMARY KEY);\n",
    "flyway/V2__email.sql": "ALTER TABLE users ADD COLUMN email text NOT NULL;\n",
    "flyway/V10__mood.sql": "ALTER TABLE users ADD COLUMN m text;\n",
    "flyway/U10__mood.sql": "ALTER TABLE users DROP COLUMN m;\n",
    "flyway/R__views.sql": "CREATE OR REPLACE VIEW user_moods AS SELECT id, m FROM users;\n",
  });
  try {
    for (const dir of ["migrate", "flyway"])
      assert.deepEqual(await problemsAndColumns(dir, f.config, USERS), { problems: [], columns: ["id email m?"] }, dir);
    const order = resolveSchemaFiles({ schema: "flyway" }, f.config).map((p) => p.slice(p.lastIndexOf("/") + 1));
    assert.deepEqual(order, ["V1__users.sql", "V2__email.sql", "V10__mood.sql", "R__views.sql"]);
  } finally {
    f.done();
  }
});

test("schema errors point at the line in the file, also after text before -- migrate:up", async () => {
  const f = folder({
    "20260101_users.sql": "-- A dbmate migration with notes first.\n-- More notes.\n\n-- migrate:up\nCREATE TABLE users (id int PRIMARY KEY, email nope NOT NULL);\n\n-- migrate:down\nDROP TABLE users;\n",
  });
  try {
    const r = await problemsAndColumns("20260101_users.sql", f.config, USERS);
    assert.equal(r.problems.length, 1);
    assert.match(r.problems[0], /20260101_users\.sql:5:\d+: type "nope" does not exist/);
    assert.equal(readSchema(resolveSchemaFiles({ schema: "20260101_users.sql" }, f.config)).sql.split("\n").length >= 5, true);
  } finally {
    f.done();
  }
});
