// feature: Two columns with the same name are both returned, the second as name_2 (as in sqlc)
import { authorAndBook } from "./same_names.sql";
import type { Equal, Row } from "./_helpers.ts";
import { expect } from "./_helpers.ts";
expect<Equal<Row<typeof authorAndBook>, { id: number; id_2: string | null; title: string | null }>>();
