import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "fs";
import path from "path";
import * as schema from "./schema";
import { applyLegacyBaseline } from "./legacyBaseline";

// SQLite for MVP. The rest of the app talks only to the drizzle `db` object,
// so swapping to Postgres later means changing this file + schema imports only.
//
// Schema lives once, in ./schema.ts. `npm run db:generate` (drizzle-kit) emits
// SQL migrations into ./drizzle, which getDb() applies on open. Databases from
// before the migration switch are detected (app tables but no journal) and
// baselined: the frozen legacy DDL catches them up to migration 0000, which is
// then recorded as applied so only future migrations run.

const MIGRATIONS_FOLDER = () => path.resolve(process.cwd(), "drizzle");

let _db: BetterSQLite3Database<typeof schema> | null = null;
let _sqlite: InstanceType<typeof Database> | null = null;

const tableExists = (sqlite: InstanceType<typeof Database>, name: string): boolean =>
  sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !=
  null;

export function getDb(): BetterSQLite3Database<typeof schema> {
  if (_db) return _db;
  const dbPath = process.env.DATABASE_PATH || "./data/finance-agent.db";
  // ":memory:" gives tests a throwaway in-process database with the full schema.
  const inMemory = dbPath === ":memory:";
  const resolved = inMemory ? dbPath : path.resolve(process.cwd(), dbPath);
  if (!inMemory) fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const sqlite = new Database(resolved);
  _sqlite = sqlite;
  if (!inMemory) sqlite.pragma("journal_mode = WAL");

  // Baseline pre-drizzle-kit databases: they already carry the migration-0000
  // schema (via the legacy DDL), so mark that migration applied instead of
  // letting it fail on existing tables. Fresh databases skip this and are
  // built entirely by the migrations.
  if (!tableExists(sqlite, "__drizzle_migrations") && tableExists(sqlite, "watchlist_items")) {
    applyLegacyBaseline(sqlite); // catch very old copies up to migration 0000
    const journal = JSON.parse(
      fs.readFileSync(path.join(MIGRATIONS_FOLDER(), "meta/_journal.json"), "utf8"),
    ) as { entries: { idx: number; when: number }[] };
    const initial = journal.entries[0];
    sqlite.exec(
      "CREATE TABLE IF NOT EXISTS __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)",
    );
    sqlite
      .prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)")
      .run("baseline-pre-drizzle-kit", initial.when);
  }

  _db = drizzle(sqlite, { schema });
  migrate(_db, { migrationsFolder: MIGRATIONS_FOLDER() });
  return _db;
}

/**
 * Close and forget the cached connection so the next getDb() re-opens it.
 * Test-harness hook: with DATABASE_PATH=":memory:" each reset yields a fresh,
 * fully-migrated database. Safe (if pointless) to call in production code.
 */
export function resetDbForTests(): void {
  _sqlite?.close();
  _sqlite = null;
  _db = null;
}

export { schema };
