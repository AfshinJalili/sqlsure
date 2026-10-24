// feature: Aggregates and windows: count/row_number/EXISTS/COALESCE(…, literal) are non-null; sum/max/lag are nullable
import { stats, ranked, hasBooks } from "./aggregates.sql";
import type { Equal, Row } from "./_helpers.ts";
import { expect } from "./_helpers.ts";
expect<Equal<Row<typeof stats>, { n: string; with_pages: string; total_pages: string | null; top_price: string | null; total_or_zero: string }>>();
expect<Equal<Row<typeof ranked>, { id: string; rn: string; prev: string | null }>>();
expect<Equal<Row<typeof hasBooks>, { has_books: boolean }>>();
