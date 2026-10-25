// feature: Joins: INNER keeps NOT NULL, LEFT/RIGHT/FULL/LATERAL make the outer side nullable, alias by alias in a self-join
import { booksWithAuthors, authorsWithBooks, everything, lastBook, sameAuthorEmail } from "./joins.sql";
import type { Equal, Row } from "./_helpers.ts";
import { expect } from "./_helpers.ts";
expect<Equal<Row<typeof booksWithAuthors>, { title: string; author: string }>>();
expect<Equal<Row<typeof authorsWithBooks>, { name: string; title: string | null }>>();
expect<Equal<Row<typeof everything>, { name: string | null; title: string | null }>>();
expect<Equal<Row<typeof lastBook>, { name: string; title: string | null }>>();
expect<Equal<Row<typeof sameAuthorEmail>, { name: string; other_name: string | null }>>();
