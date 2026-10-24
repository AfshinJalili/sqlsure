// feature: INSERT/UPDATE … RETURNING, :exec (void) and :execrows (affected row count)
import { createAuthor, renameBook, deleteBook, archiveAll } from "./writes.sql";
import type { Equal, Result, Params } from "./_helpers.ts";
import { expect } from "./_helpers.ts";
expect<Equal<Result<typeof createAuthor>, { id: number; name: string; email: string | null } | null>>();
expect<Equal<Params<typeof createAuthor>, { name: string; email: string | null }>>();
expect<Equal<Result<typeof renameBook>, { id: string; title: string } | null>>();
expect<Equal<Result<typeof deleteBook>, number>>();
expect<Equal<Result<typeof archiveAll>, void>>();
