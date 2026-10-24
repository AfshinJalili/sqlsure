// feature: Enums become string-literal unions, for columns and parameters
import { booksByStatus } from "./enums.sql";
import type { Equal, Row, Params } from "./_helpers.ts";
import type { Queryable } from "sqlsure/runtime";
import { expect } from "./_helpers.ts";
expect<Equal<Row<typeof booksByStatus>["status"], "draft" | "live" | "archived">>();
expect<Equal<Params<typeof booksByStatus>, { status: "draft" | "live" | "archived" }>>();
declare const db: Queryable;
// @ts-expect-error not a label of the enum
booksByStatus(db, { status: "deleted" });
