// `plugins: [sqlsure()]` in an esbuild build (and tools built on it, such as tsup): bundles .sql
// imports as the same small modules sqlsure/register loads. Bun's plugin API is esbuild's, so
// sqlsure/bun registers this same plugin.
import { readFile } from "node:fs/promises";
import { compileSqlModule } from "./emit.ts";

/** An esbuild (and Bun) plugin. Typed structurally, so sqlsure does not depend on esbuild. */
export interface SqlsureEsbuildPlugin {
  name: string;
  setup(build: {
    onLoad(options: { filter: RegExp }, callback: (args: { path: string }) => Promise<{ contents: string; loader: "js" }>): void;
  }): void;
}

export default function sqlsure(): SqlsureEsbuildPlugin {
  return {
    name: "sqlsure",
    setup(build) {
      build.onLoad({ filter: /\.sql$/ }, async ({ path }) => ({ contents: compileSqlModule(await readFile(path, "utf8"), path), loader: "js" }));
    },
  };
}
