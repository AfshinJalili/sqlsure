// feature: SELECT with NOT NULL and nullable columns; :one returns Row | null
import { getAuthor } from "./select.sql";
import type { Equal, Result, Params } from "./_helpers.ts";
import { expect } from "./_helpers.ts";
expect<Equal<Result<typeof getAuthor>, { id: number; name: string; email: string | null; created_at: Date } | null>>();
expect<Equal<Params<typeof getAuthor>, { id: number }>>();
