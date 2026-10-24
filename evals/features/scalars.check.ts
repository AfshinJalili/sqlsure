// feature: Scalar types as node-postgres returns them (int8/numeric as string, dates as Date, bytea as Buffer, interval, point)
import { bookScalars } from "./scalars.sql";
import type { Equal, Row } from "./_helpers.ts";
import type { Interval } from "sqlsure/runtime";
import { expect } from "./_helpers.ts";
expect<Equal<Row<typeof bookScalars>, {
  id: string; price: string; pages: number | null; rating: number | null; weight: number | null;
  cover: Buffer | null; isbn: string | null; published_on: Date | null; read_time: Interval | null;
  location: { x: number; y: number } | null;
}>>();
