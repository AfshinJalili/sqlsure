// `plugins: [sqlsure()]` in vite.config.ts or vitest.config.ts: makes `import { getUser } from
// "./users.sql"` work in Vite, Vitest and Rollup. Like sqlsure/register, it needs no schema and no
// database: it only splits the file and rewrites parameters.
import { compileSqlModule } from "./emit.ts";

/** A Vite (and Rollup) plugin. Typed structurally, so sqlsure does not depend on Vite. */
export interface SqlsureVitePlugin {
  name: string;
  enforce: "pre";
  transform(code: string, id: string): { code: string; map: null } | null;
}

export default function sqlsure(): SqlsureVitePlugin {
  return {
    name: "sqlsure",
    enforce: "pre",
    transform(code, id) {
      // `?raw`, `?url` and virtual modules keep their usual meaning.
      if (!id.endsWith(".sql") || id.startsWith("\0")) return null;
      return { code: compileSqlModule(code, id), map: null };
    },
  };
}
