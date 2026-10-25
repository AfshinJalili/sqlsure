// feature: Schema-qualified tables, quoted identifiers, views (columns proven from the view's definition), queries named like sqlsure types
import { archived, odd, fromView, Json } from "./naming.sql";
import type { Equal, Row } from "./_helpers.ts";
import { expect } from "./_helpers.ts";
expect<Equal<Row<typeof archived>, { id: string; title: string }>>();
expect<Equal<Row<typeof odd>, { "Odd Name": string | null }>>();
expect<Equal<Row<typeof fromView>, { id: string; title: string }>>();
expect<Equal<Row<typeof Json>, { id: string }>>();
