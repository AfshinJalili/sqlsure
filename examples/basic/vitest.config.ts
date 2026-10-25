import { defineConfig } from "vitest/config";
import sqlsure from "sqlsure/vite";

export default defineConfig({ plugins: [sqlsure()] });
