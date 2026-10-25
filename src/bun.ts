// `bun --preload sqlsure/bun app.ts`, or `preload = ["sqlsure/bun"]` in bunfig.toml: makes .sql
// imports work under Bun, the way sqlsure/register does under Node.
import sqlsure from "./esbuild.ts";

const { Bun } = globalThis as unknown as { Bun?: { plugin(plugin: unknown): void } };
if (!Bun) throw new Error("sqlsure/bun runs under Bun. Under Node, use node --import sqlsure/register.");
Bun.plugin(sqlsure());
