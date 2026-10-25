// feature: Schema-qualified tables, quoted identifiers, views (view columns are conservatively nullable), queries named like sqlsure types
import { archived, odd, fromView, Json } from "./naming.sql";
import type { Equal, Row } from "./_helpers.ts";
import { expect } from "./_helpers.ts";
expect<Equal<Row<typeof archived>, { id: string; title: string }>>();
expect<Equal<Row<typeof odd>, { "Odd Name": string | null }>>();
expect<Equal<Row<typeof fromView>, { id: string | null; title: string | null }>>();
expect<Equal<Row<typeof Json>, { id: string }>>();
