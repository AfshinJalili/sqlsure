// feature: json/jsonb as a Json value; JSON parameters take objects or pre-stringified JSON
import { bookMeta, setMeta } from "./json.sql";
import type { Equal, Row, Params } from "./_helpers.ts";
import type { Json } from "sqlsure/runtime";
import { expect } from "./_helpers.ts";
expect<Equal<Row<typeof bookMeta>, { meta: Json; extra: Json | null; k: Json | null; k_text: string | null }>>();
expect<Equal<Params<typeof setMeta>, { meta: { [key: string]: Json } | string; id: number | string | bigint }>>();
