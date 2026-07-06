import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";

// Daily SQLite backup (roadmap #14): a consistent `VACUUM INTO` copy of the
// database written by daily maintenance into data/backups/, one file per day,
// keeping the last BACKUP_KEEP_DAYS. VACUUM INTO produces a compact snapshot
// that's safe to copy while the app is running (WAL mode).

const BACKUP_KEEP_DAYS = 7;

export const dbPath = () =>
  path.resolve(process.cwd(), process.env.DATABASE_PATH || "./data/finance-agent.db");

export const backupDir = () => path.join(path.dirname(dbPath()), "backups");

export interface BackupResult {
  path: string;
  bytes: number;
  /** False when today's backup already existed and nothing was written. */
  created: boolean;
  pruned: string[];
}

/** List existing backups, newest first. */
export function listBackups(): { file: string; bytes: number; modifiedAt: string }[] {
  const dir = backupDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".db"))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { file: f, bytes: st.size, modifiedAt: st.mtime.toISOString() };
    })
    .sort((a, b) => b.file.localeCompare(a.file));
}

/** Write today's backup (idempotent per day) and prune old ones. */
export function runBackup(): BackupResult {
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const file = path.join(dir, `finance-agent-${day}.db`);

  let created = false;
  if (!fs.existsSync(file)) {
    getDb().run(sql`VACUUM INTO ${file}`);
    created = true;
  }

  // Prune: keep the newest BACKUP_KEEP_DAYS files (names sort by date).
  const pruned: string[] = [];
  for (const b of listBackups().slice(BACKUP_KEEP_DAYS)) {
    fs.unlinkSync(path.join(dir, b.file));
    pruned.push(b.file);
  }

  return { path: file, bytes: fs.statSync(file).size, created, pruned };
}
