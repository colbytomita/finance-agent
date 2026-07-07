import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { dbPath, backupDir, listBackups } from "@/services/backup";
import { nowIso } from "@/lib/util";

// Restore the SQLite database from a backup (roadmap #19). Companion to the
// daily VACUUM INTO backups in backup.ts. Usage:
//   npm run db:restore -- <backup-file>
// where <backup-file> is a filename in data/backups/ or a path. Refuses to run
// while the DB is open (stop dev + jobs first), snapshots the current DB to a
// pre-restore copy, swaps the chosen backup into place, and clears stale WAL/SHM
// sidecars so the next open doesn't replay the old journal. The app applies any
// newer migrations automatically the next time it opens the file.

function fail(msg: string): never {
  console.error(`db:restore: ${msg}`);
  process.exit(1);
}

/** A bare filename resolves inside data/backups/; anything with a path is used as-is. */
function resolveBackup(arg: string): string {
  return /[\\/]/.test(arg) || path.isAbsolute(arg) ? path.resolve(arg) : path.join(backupDir(), arg);
}

/**
 * Refuse when another process holds the DB open. Renaming a file that's open by
 * another process fails on Windows (the handle locks the name), so a rename
 * probe reliably detects a running dev server / jobs runner — more so than a
 * SQLite lock, which an idle-but-open WAL connection wouldn't trip.
 */
function assertNotInUse(dbFile: string): void {
  if (!fs.existsSync(dbFile)) return;
  const probe = `${dbFile}.inuse-${process.pid}`;
  try {
    fs.renameSync(dbFile, probe);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "";
    fail(
      `the database looks like it's in use${code ? ` (${code})` : ""}. ` +
        "Stop `npm run dev` and `npm run jobs` (and close the /status page), then retry.",
    );
  }
  try {
    fs.renameSync(probe, dbFile);
  } catch (e) {
    fail(
      `the in-use check could not put the database back: ${String(e)}. ` +
        `Your database is currently at ${probe} — rename it to ${dbFile} before restarting.`,
    );
  }
}

function main(): void {
  const arg = process.argv[2];
  const target = dbPath();

  if (!arg) {
    console.error("Usage: npm run db:restore -- <backup-file>\n");
    const backups = listBackups();
    if (backups.length) {
      console.error(`Available backups in ${backupDir()}:`);
      for (const b of backups) {
        console.error(`  ${b.file}  (${(b.bytes / 1024 / 1024).toFixed(1)} MB, ${b.modifiedAt.slice(0, 10)})`);
      }
    } else {
      console.error(`No backups found in ${backupDir()}.`);
    }
    process.exit(1);
  }

  const source = resolveBackup(arg);
  if (!fs.existsSync(source)) fail(`backup file not found: ${source}`);
  if (path.resolve(source) === path.resolve(target)) fail("the backup and the live database are the same file.");

  assertNotInUse(target);

  // Snapshot the current DB first, so a restore is always reversible.
  fs.mkdirSync(backupDir(), { recursive: true });
  let preRestore: string | null = null;
  if (fs.existsSync(target)) {
    preRestore = path.join(backupDir(), `pre-restore-${nowIso().replace(/[:.]/g, "-")}.db`);
    const cur = new Database(target, { fileMustExist: true });
    try {
      cur.exec(`VACUUM INTO '${preRestore.replace(/'/g, "''")}'`);
    } finally {
      cur.close();
    }
  }

  // Swap the backup into place, then drop stale WAL/SHM so SQLite doesn't replay
  // the previous journal onto the restored file.
  fs.copyFileSync(source, target);
  for (const ext of ["-wal", "-shm"]) {
    const side = target + ext;
    if (fs.existsSync(side)) fs.unlinkSync(side);
  }

  console.log(`Restored ${path.basename(source)} -> ${target}`);
  if (preRestore) console.log(`Previous database saved to ${path.basename(preRestore)}`);
  console.log("Start the app (npm run dev / npm run jobs); it applies any newer migrations on open.");
}

main();
