import pg from "pg";
import { createUser, getUser, usersWithPostCounts } from "./users.sql";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const created = await createUser(pool, { email: `demo+${Date.now()}@example.com`, displayName: null });
const user = await getUser(pool, { id: created!.id });
console.log(user?.email, user?.created_at.toISOString());

for (const row of await usersWithPostCounts(pool)) {
  // row: { email: string; posts: string; latest_title: string | null }
  console.log(row.email, row.posts, row.latest_title ?? "(no posts)");
}
await pool.end();
