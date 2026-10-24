// feature: Named :params (reused names are one parameter); casts, strings, dollar quotes and comments are left alone
import { search, noParams, tricky } from "./params.sql";
import type { Equal, Params } from "./_helpers.ts";
import type { Queryable } from "sqlsure/runtime";
import { expect } from "./_helpers.ts";
expect<Equal<Params<typeof search>, { q: string; limit: number | string | bigint }>>();
expect<Equal<Params<typeof tricky>, { title: string }>>();
declare const db: Queryable;
noParams(db);
// @ts-expect-error a required parameter is missing
search(db, { q: "x" });
// @ts-expect-error unknown parameter
search(db, { q: "x", limit: 1, nope: 1 });
// @ts-expect-error wrong parameter type
search(db, { q: 1, limit: 1 });
