// feature: Every query function carries its final SQL and parameter order
import { search } from "./params.sql";
import type { Equal } from "./_helpers.ts";
import { expect } from "./_helpers.ts";
expect<Equal<typeof search.sql, string>>();
expect<Equal<typeof search.paramNames, readonly string[]>>();
expect<Equal<typeof search.mode, "one" | "many" | "exec" | "execrows">>();
