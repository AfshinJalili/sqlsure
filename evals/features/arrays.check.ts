// feature: Arrays (elements may be NULL); arrays of enums come back as text, typed string
import { bookArrays, booksWithTag } from "./arrays.sql";
import type { Equal, Row, Params } from "./_helpers.ts";
import { expect } from "./_helpers.ts";
expect<Equal<Row<typeof bookArrays>, { tags: (string | null)[]; scores: (number | null)[] | null; statuses: string }>>();
expect<Equal<Params<typeof booksWithTag>, { tags: (string | null)[] }>>();
