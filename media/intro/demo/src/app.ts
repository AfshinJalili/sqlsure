import pg from "pg";
import { getUser } from "./users.sql";

const pool = new pg.Pool();
const user = await getUser(pool, { id: 42 });
