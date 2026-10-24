// The oracle: a real Postgres server reached through the real `pg` driver. Each suite gets a fresh
// database so nothing leaks between them.
import pg from "pg";

export const PG_URL = process.env.SQLSURE_EVAL_PG ?? "postgres://postgres@127.0.0.1:54329/postgres";

export async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: PG_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

export async function freshDatabase(name: string): Promise<pg.Client> {
  const db = `sqlsure_eval_${name.replace(/[^a-z0-9_]/gi, "_").toLowerCase()}`.slice(0, 63);
  await admin(async (c) => {
    await c.query(`drop database if exists "${db}" with (force)`);
    await c.query(`create database "${db}"`);
  });
  const url = new URL(PG_URL);
  url.pathname = `/${db}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  client.on("error", () => {});
  return client;
}

export async function dropDatabase(client: pg.Client): Promise<void> {
  const db = client.database;
  await client.end().catch(() => {});
  if (db) await admin((c) => c.query(`drop database if exists "${db}" with (force)`)).catch(() => {});
}

export interface PreparedTypes {
  params: string[];
  results: string[] | null;
}

let counter = 0;
/** Real Postgres' own view of a statement's types, via PREPARE. */
export async function preparedTypes(client: pg.Client, sql: string): Promise<PreparedTypes> {
  const name = `sqlsure_p${counter++}`;
  await client.query(`PREPARE ${name} AS ${sql}`);
  try {
    const r = await client.query(
      "select parameter_types::text[] as params, result_types::text[] as results from pg_prepared_statements where name = $1",
      [name],
    );
    return { params: r.rows[0].params ?? [], results: r.rows[0].results };
  } finally {
    await client.query(`DEALLOCATE ${name}`);
  }
}
