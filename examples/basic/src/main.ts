import pg from "pg";
import { createUser, deleteUser, getUser, usersWithPostCounts, type GetUserRow } from "./users.sql";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const created = await createUser(pool, { email: `demo+${Date.now()}@example.com`, displayName: null });
const user: GetUserRow | null = await getUser(pool, { id: created!.id });
console.log(user?.email, user?.created_at.toISOString());

for (const row of await usersWithPostCounts(pool)) {
  // row: { email: string; posts: string; latest_title: string | null }
  console.log(row.email, row.posts, row.latest_title ?? "(no posts)");
}

// Query functions take a PoolClient too, so they run inside transactions.
const client = await pool.connect();
try {
  await client.query("BEGIN");
  const deleted: number = await deleteUser(client, { id: created!.id });
  await client.query("ROLLBACK");
  console.log("deleted in a rolled-back transaction:", deleted);
} finally {
  client.release();
}
await pool.end();
