// Postgres' own parser (libpg-query: the server's grammar compiled to WebAssembly), loaded once.
// Parsing never touches a database; it only turns SQL text into Postgres' raw parse tree.
import { loadModule, parseSync } from "libpg-query";

export type ParseNode = Record<string, any>;

let loaded: Promise<void> | undefined;

/** The raw parse tree of `sql`. Throws on a syntax error. */
export async function parse(sql: string): Promise<ParseNode> {
  await (loaded ??= loadModule());
  return parseSync(sql) as ParseNode;
}
