import { defineConfig } from "drizzle-kit";

// drizzle-kit config (roadmap #5): schema.ts is the single source of truth;
// `npm run db:generate` emits SQL migrations into ./drizzle, applied by
// getDb() at startup. Existing pre-migration databases are baselined in code.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
