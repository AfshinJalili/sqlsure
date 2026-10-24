// feature: CTEs and set operations (UNION output is conservatively nullable)
import { prolific, unionTitles } from "./cte.sql";
import type { Equal, Row } from "./_helpers.ts";
import { expect } from "./_helpers.ts";
expect<Equal<Row<typeof prolific>, { name: string; n: string | null }>>();
expect<Equal<Row<typeof unionTitles>, { title: string | null }>>();
