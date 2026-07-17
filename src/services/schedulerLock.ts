import fs from "node:fs";
import path from "node:path";

// Single-instance guard for the background scheduler (roadmap #51). Two
// schedulers against one SQLite database double every refresh and race the
// maintenance chain — the README could only *warn* about it. The lock is a
// pidfile: exclusive-create wins; an existing file is honored only while its
// pid is alive, so a hard-killed runner (Stop-ScheduledTask, crash, reboot)
// never wedges the next start. Lock ERRORS never stop the runner — only a
// live holder does.

export function defaultLockPath(): string {
  return path.resolve(process.cwd(), "data", "jobs.lock");
}

/** process.kill(pid, 0) probes liveness; EPERM means "alive, not ours". */
const defaultIsPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

export interface LockResult {
  acquired: boolean;
  holderPid?: number;
}

export function acquireSchedulerLock(
  opts: { lockPath?: string; pid?: number; isPidAlive?: (pid: number) => boolean } = {},
): LockResult {
  const lockPath = opts.lockPath ?? defaultLockPath();
  const pid = opts.pid ?? process.pid;
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, String(pid), { flag: "wx" });
    return { acquired: true };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
      // Unreadable dir, permissions, exotic fs failure — do not block the runner.
      return { acquired: true };
    }
  }
  try {
    const holder = parseInt(fs.readFileSync(lockPath, "utf8").trim(), 10);
    if (Number.isFinite(holder) && holder !== pid && isPidAlive(holder)) {
      return { acquired: false, holderPid: holder };
    }
  } catch {
    /* unreadable content — treat as stale */
  }
  try {
    fs.writeFileSync(lockPath, String(pid)); // steal the stale lock
    // Re-read after writing: if a simultaneous starter also stole this stale
    // lock, the LAST writer owns it and everyone else backs off — narrows the
    // read-then-write race between a logon task start and a manual run to the
    // width of a single write.
    const now = fs.readFileSync(lockPath, "utf8").trim();
    if (now !== String(pid)) {
      const holder = parseInt(now, 10);
      return { acquired: false, ...(Number.isFinite(holder) ? { holderPid: holder } : {}) };
    }
  } catch {
    /* best effort — lock errors never stop the runner */
  }
  return { acquired: true };
}

/** Remove the lock iff this pid owns it. Best-effort, never throws. */
export function releaseSchedulerLock(opts: { lockPath?: string; pid?: number } = {}): void {
  const lockPath = opts.lockPath ?? defaultLockPath();
  const pid = opts.pid ?? process.pid;
  try {
    if (fs.readFileSync(lockPath, "utf8").trim() === String(pid)) fs.unlinkSync(lockPath);
  } catch {
    /* missing or foreign — nothing to do */
  }
}
