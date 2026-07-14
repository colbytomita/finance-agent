# Roadmap v6 (#51–#55): Runner Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the background job runner survive real-world operation (hidden scheduled task, single-instance lock, sleep-proof scheduling for every job), repair or retire the rotten Yahoo browser fallback, surface silent data-source failures on /status, and add a watchdog that alerts when the runner itself is dead.

**Architecture:** All changes ride the existing patterns: pure, unit-tested decision functions in `src/services/` consumed by the thin `src/jobs/scheduler.ts` runner; opt-in PowerShell installers in `scripts/`; /status additions via pure helpers in `status.ts` + a card in `src/app/status/page.tsx`. No schema changes, no new dependencies (node-cron is *removed*).

**Tech Stack:** TypeScript strict, Next.js 16, better-sqlite3 + drizzle, vitest, tsx entrypoints, Windows Task Scheduler via PowerShell + a hidden-window VBS launcher.

**Spec:** `docs/ROADMAP.md` top section (v6, items #51–#55), commit 971519d.

## Global Constraints

- Real data only: never seed or fabricate rows; the SQLite file under `data/` is the user's working data.
- Every timestamp written via `nowIso()` from `@/lib/util` (never `new Date().toISOString()` inline).
- Any NEW tsx entrypoint calls `loadDotEnv()` from `@/lib/loadEnv` before any other import executes env reads (roadmap #40 rule).
- Never edit `src/db/legacyBaseline.ts` or applied migrations. (This plan needs no schema changes at all.)
- Persistence tests use `useTestDb()` from `src/services/__tests__/dbHarness.ts`; pure logic tests need no DB.
- `npm run typecheck` and `npm test` must pass before every commit. Commit straight to `main` and push after each task (user's standing workflow).
- Keep the "decision support, not autopilot" framing in any user-facing copy.
- The user's machine is the production host (UTC-10). The live DB may be mid-use; scripts that touch Task Scheduler affect a real running service.

---

### Task 1: Single-instance scheduler lock (#51b)

**Files:**
- Create: `src/services/schedulerLock.ts`
- Create: `src/services/__tests__/schedulerLock.test.ts`
- Modify: `src/jobs/scheduler.ts` (top of run section ~line 342, and the signal handler ~line 398)

**Interfaces:**
- Consumes: nothing new.
- Produces (used by Task 2's live verify and by scheduler.ts):
  - `acquireSchedulerLock(opts?: { lockPath?: string; pid?: number; isPidAlive?: (pid: number) => boolean }): { acquired: boolean; holderPid?: number }`
  - `releaseSchedulerLock(opts?: { lockPath?: string; pid?: number }): void`
  - `defaultLockPath(): string` — `path.resolve(process.cwd(), "data", "jobs.lock")`

- [ ] **Step 1: Write the failing tests**

Create `src/services/__tests__/schedulerLock.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireSchedulerLock, releaseSchedulerLock } from "../schedulerLock";

const tmpLock = () =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fa-lock-")), "jobs.lock");

describe("schedulerLock", () => {
  it("acquires a fresh lock and writes its pid", () => {
    const lockPath = tmpLock();
    const res = acquireSchedulerLock({ lockPath, pid: 111 });
    expect(res.acquired).toBe(true);
    expect(fs.readFileSync(lockPath, "utf8")).toBe("111");
  });

  it("refuses when the holder pid is alive", () => {
    const lockPath = tmpLock();
    fs.writeFileSync(lockPath, "222");
    const res = acquireSchedulerLock({ lockPath, pid: 111, isPidAlive: () => true });
    expect(res).toEqual({ acquired: false, holderPid: 222 });
    expect(fs.readFileSync(lockPath, "utf8")).toBe("222"); // untouched
  });

  it("steals a lock whose holder pid is dead", () => {
    const lockPath = tmpLock();
    fs.writeFileSync(lockPath, "222");
    const res = acquireSchedulerLock({ lockPath, pid: 111, isPidAlive: () => false });
    expect(res.acquired).toBe(true);
    expect(fs.readFileSync(lockPath, "utf8")).toBe("111");
  });

  it("steals a garbage lockfile", () => {
    const lockPath = tmpLock();
    fs.writeFileSync(lockPath, "not-a-pid");
    // isPidAlive must not even be consulted for garbage content.
    const res = acquireSchedulerLock({
      lockPath,
      pid: 111,
      isPidAlive: () => {
        throw new Error("must not be called");
      },
    });
    expect(res.acquired).toBe(true);
    expect(fs.readFileSync(lockPath, "utf8")).toBe("111");
  });

  it("release removes only its own lock", () => {
    const lockPath = tmpLock();
    fs.writeFileSync(lockPath, "111");
    releaseSchedulerLock({ lockPath, pid: 999 }); // someone else's — keep
    expect(fs.existsSync(lockPath)).toBe(true);
    releaseSchedulerLock({ lockPath, pid: 111 }); // ours — remove
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("acquires despite fs errors (lock errors never stop the runner)", () => {
    // A directory that cannot exist as a file parent on Windows/Unix alike:
    // point the lock INTO a path whose parent is a file.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fa-lock-"));
    const fileAsParent = path.join(dir, "iamafile");
    fs.writeFileSync(fileAsParent, "x");
    const res = acquireSchedulerLock({ lockPath: path.join(fileAsParent, "jobs.lock"), pid: 111 });
    expect(res.acquired).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/__tests__/schedulerLock.test.ts`
Expected: FAIL — `Cannot find module '../schedulerLock'` (or equivalent).

- [ ] **Step 3: Implement `src/services/schedulerLock.ts`**

```ts
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
  } catch {
    /* best effort */
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/__tests__/schedulerLock.test.ts`
Expected: 6 passed.

- [ ] **Step 5: Wire into the scheduler**

In `src/jobs/scheduler.ts`, add to the jobHealth import block's neighborhood:

```ts
import { acquireSchedulerLock, releaseSchedulerLock } from "@/services/schedulerLock";
```

Immediately BEFORE the existing line `log("scheduler starting — Ctrl+C to stop");` insert:

```ts
// Single-instance guard (roadmap #51): a manual `npm run jobs` and the
// FinanceAgentJobs scheduled task must never both run against the database.
{
  const lock = acquireSchedulerLock();
  if (!lock.acquired) {
    log(
      `another scheduler (pid ${lock.holderPid}) is already running against this database — exiting. ` +
        `Stop it first (Stop-ScheduledTask -TaskName FinanceAgentJobs, or Ctrl+C the other terminal).`,
    );
    process.exit(1);
  }
}
```

Change the startup log line (Ctrl+C is no longer the only stop path):

```ts
log("scheduler starting — Ctrl+C or Stop-ScheduledTask to stop");
```

In the shutdown handler, release the lock before the flush:

```ts
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log(`${sig} — flushing queued notifications and stopping`);
    releaseSchedulerLock();
    void flushQueuedNotifications().finally(() => process.exit(0));
  });
}
```

- [ ] **Step 6: Full check**

Run: `npm run typecheck && npm test`
Expected: clean; suite grows by 6 tests.

- [ ] **Step 7: Verify the guard live**

The runner is currently dead (no node scheduler process), so:
1. Terminal A: `npm run jobs` → starts, heartbeat logs appear.
2. Terminal B: `npm run jobs` → must print "another scheduler (pid N) is already running…" and exit 1.
3. Ctrl+C terminal A → confirm `data/jobs.lock` is gone (released on SIGINT).
4. Leave the runner STOPPED (Task 2 starts it as a scheduled task).

- [ ] **Step 8: Commit**

```bash
git add src/services/schedulerLock.ts src/services/__tests__/schedulerLock.test.ts src/jobs/scheduler.ts
git commit -m "Single-instance scheduler lock (roadmap #51b)" && git push
```

---

### Task 2: Hidden-window task launcher + install script (#51a)

**Files:**
- Create: `scripts/run-hidden.vbs`
- Modify: `scripts/install-jobs-task.ps1`
- Modify: `README.md` ("Keeping the scheduler running (Windows)" section)
- (No change needed to `scripts/uninstall-jobs-task.ps1` — it already `Stop-ScheduledTask`s before unregistering; verify only.)

**Interfaces:**
- Consumes: Task 1's lock (live verification).
- Produces: `scripts/run-hidden.vbs` taking `<npmScript> <logFileRelativeToRoot>` — Task 7's watchdog installer reuses it verbatim.

- [ ] **Step 1: Write `scripts/run-hidden.vbs`**

```vbs
' Hidden-window npm launcher for Finance Agent scheduled tasks (roadmap #51).
' The task action used to be a bare `cmd.exe /c npm run jobs`, which opens a
' console window at every logon — closing that window killed the runner
' (observed: exit 0xC000013A 13s after logon, dead all day). wscript runs the
' same command with window style 0 (hidden) and waits, so the task shows
' "Running" and Stop-ScheduledTask terminates the whole tree.
'
' Usage: wscript.exe run-hidden.vbs <npmScript> <logFileRelativeToRoot>
'   e.g. wscript.exe run-hidden.vbs jobs data\logs\jobs.log
Option Explicit
Dim shell, fso, root, npmScript, logRel, logFile
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
If WScript.Arguments.Count < 2 Then
  WScript.Echo "usage: run-hidden.vbs <npmScript> <logFileRelativeToRoot>"
  WScript.Quit 2
End If
npmScript = WScript.Arguments(0)
logRel = WScript.Arguments(1)
' Project root = parent of this script's folder (scripts\..).
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
shell.CurrentDirectory = root
logFile = root & "\" & logRel
If Not fso.FolderExists(fso.GetParentFolderName(logFile)) Then
  fso.CreateFolder (fso.GetParentFolderName(logFile))
End If
' 0 = hidden window, True = wait for exit (keeps the task "Running").
WScript.Quit shell.Run("cmd /c npm run " & npmScript & " >> """ & logFile & """ 2>&1", 0, True)
```

- [ ] **Step 2: Update `scripts/install-jobs-task.ps1`**

Add a `param` block as the FIRST executable line (above `$ErrorActionPreference`):

```powershell
param(
    # Start the task immediately after registering it.
    [switch]$StartNow
)
```

Replace the action block (the `$innerCmd`/`$action` lines and their comment):

```powershell
# Launch through the hidden-window VBS wrapper (roadmap #51): a bare cmd.exe
# action opens a console window at every logon, and closing that window kills
# the runner. wscript runs it hidden and waits, so the task shows "Running"
# and Stop-ScheduledTask terminates the tree. Output still lands in jobs.log.
$vbs = Join-Path $PSScriptRoot "run-hidden.vbs"
$action = New-ScheduledTaskAction -Execute "wscript.exe" `
    -Argument "`"$vbs`" jobs data\logs\jobs.log" -WorkingDirectory $ProjectRoot
```

Replace the final Write-Host block (after the existence check) with:

```powershell
Write-Host "Registered scheduled task '$TaskName'." -ForegroundColor Green
Write-Host "  - Starts 'npm run jobs' at logon, in a hidden window (no console to close)"
Write-Host "  - Output appended to: $LogFile"
Write-Host "  - Restarts on failure; no run-time limit"
Write-Host ""
if ($StartNow) {
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "Started it now. Check: Get-ScheduledTask -TaskName $TaskName" -ForegroundColor Green
} else {
    Write-Host "Start it now without logging off:  Start-ScheduledTask -TaskName $TaskName"
}
Write-Host "Stop it:                           Stop-ScheduledTask -TaskName $TaskName"
Write-Host "Check status:                      Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo"
Write-Host "Remove it:                         scripts\uninstall-jobs-task.ps1"
Write-Host ""
Write-Host "Note: the scheduler holds a single-instance lock — a manual 'npm run jobs'"
Write-Host "exits immediately while the task is running (and vice versa)."
```

- [ ] **Step 3: Update README**

In `README.md` § "Keeping the scheduler running (Windows)": replace the code block and the paragraph after it with:

```powershell
# from the project root, in PowerShell
scripts\install-jobs-task.ps1 -StartNow   # register + start: runs `npm run jobs` at logon, hidden, restarts on failure
Stop-ScheduledTask -TaskName FinanceAgentJobs    # stop it (it restarts at next logon)
scripts\uninstall-jobs-task.ps1           # remove it
```

And after the code block:

> Output is appended to `data/logs/jobs.log` (git-ignored). The task runs
> hidden — there is no console window to close by accident; stop it with
> `Stop-ScheduledTask`. The scheduler also holds a single-instance lock
> (`data/jobs.lock`), so an ad-hoc `npm run jobs` terminal and the task can
> never run two schedulers against the same database — whichever starts
> second exits immediately with a message.

- [ ] **Step 4: Re-register and start the task (live)**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-jobs-task.ps1 -StartNow
```

If registration fails with access denied, hand the user this to run themselves (the `!` prefix in the CLI): `! Start-Process powershell -Verb RunAs -ArgumentList '-ExecutionPolicy Bypass -File C:\Projects\finance-agent\scripts\install-jobs-task.ps1 -StartNow'`

Expected: "Registered scheduled task 'FinanceAgentJobs'." + "Started it now."

- [ ] **Step 5: Verify live, all four properties**

1. `Get-ScheduledTask -TaskName FinanceAgentJobs` → State **Running** (wscript waiting = tree alive).
2. No console window appeared; `Get-CimInstance Win32_Process -Filter "Name='node.exe'"` shows a `tsx src/jobs/scheduler.ts` process.
3. Within ~2 min, the DB heartbeat updates: `node -e "const D=require('better-sqlite3');const db=new D('data/finance-agent.db',{readonly:true});console.log(db.prepare(\"SELECT last_run_at FROM job_runs WHERE job='heartbeat'\").get())"` — timestamp is fresh. (Expect the maintenance catch-up to fire too — today's is overdue.)
4. `npm run jobs` in a terminal → exits immediately with the "another scheduler" message (Task 1 verified against the real task).
5. `Stop-ScheduledTask -TaskName FinanceAgentJobs` → node process gone within seconds; then `Start-ScheduledTask -TaskName FinanceAgentJobs` → running again (leave it running).

- [ ] **Step 6: Commit**

```bash
git add scripts/run-hidden.vbs scripts/install-jobs-task.ps1 README.md
git commit -m "Hidden-window scheduled task launcher + -StartNow (roadmap #51a)" && git push
```

---

### Task 3: Calendar-anchored due checks (#52, pure part)

**Files:**
- Modify: `src/services/jobHealth.ts` (replace `isDailyJobDue` + `isMaintenanceCatchupDue` with `isMaintenanceDue` + `isCatalystScanDue`)
- Modify: `src/services/__tests__/persistence.test.ts` (replace the two old describe blocks, ~lines 640–676)

**Interfaces:**
- Consumes: nothing new.
- Produces (Task 4 imports these from `@/services/jobHealth`):
  - `isMaintenanceDue(lastRunAt: string | null | undefined, now?: Date, dueHour?: number): boolean`
  - `isCatalystScanDue(lastRunAt: string | null | undefined, now?: Date, intervalHours?: number): boolean`
- **Deletes:** `isDailyJobDue`, `isMaintenanceCatchupDue` (after Task 4, nothing uses them — scheduler.ts was their only consumer; do the delete here and fix scheduler.ts imports in the same commit as Task 4 if typecheck complains — otherwise Tasks 3+4 may be committed together).

Note: Tasks 3 and 4 land as ONE commit if deleting the old helpers breaks `scheduler.ts` typecheck (it will — scheduler imports them). Run Task 3 steps, leave the old functions in place until Task 4's rewire, then delete + commit both.

- [ ] **Step 1: Write the failing tests**

In `src/services/__tests__/persistence.test.ts`, REPLACE the `isDailyJobDue` and `isMaintenanceCatchupDue` describe blocks (the update to imports happens in step 3) with:

```ts
describe("isMaintenanceDue (roadmap #52)", () => {
  // Local-time constructor: 2026-07-13 is a Monday.
  const at = (day: number, hour: number, min = 0) => new Date(2026, 6, day, hour, min);
  const iso = (d: Date) => d.toISOString();

  it("is never due before the due hour", () => {
    expect(isMaintenanceDue(iso(at(12, 22, 35)), at(13, 7, 59))).toBe(false);
    expect(isMaintenanceDue(null, at(13, 7, 59))).toBe(false);
  });

  it("is due past the hour when it has not completed for today's local date", () => {
    expect(isMaintenanceDue(null, at(13, 8, 0))).toBe(true);
    expect(isMaintenanceDue("not-a-date", at(13, 8, 0))).toBe(true);
    // Ran yesterday 23:50 — under the old >20h rule this would wait until
    // 19:50 today (the drift that missed 2026-07-12); calendar anchor fires at 08:00.
    expect(isMaintenanceDue(iso(at(12, 23, 50)), at(13, 8, 0))).toBe(true);
    // Killed mid-run yesterday evening: completion stamp stays on yesterday.
    expect(isMaintenanceDue(iso(at(12, 22, 35)), at(13, 8, 0))).toBe(true);
  });

  it("is not due again once completed today, whatever the hour", () => {
    expect(isMaintenanceDue(iso(at(13, 3, 0)), at(13, 8, 30))).toBe(false);
    expect(isMaintenanceDue(iso(at(13, 8, 5)), at(13, 22, 0))).toBe(false);
  });
});

describe("isCatalystScanDue (roadmap #52)", () => {
  const at = (day: number, hour: number, min = 0) => new Date(2026, 6, day, hour, min);
  const iso = (d: Date) => d.toISOString();
  const h = 3600_000;

  it("never fires on weekends", () => {
    expect(isCatalystScanDue(null, at(11, 12, 0))).toBe(false); // Sat
    expect(isCatalystScanDue(null, at(12, 12, 0))).toBe(false); // Sun
  });

  it("fires on a weekday when never run, unparseable, or older than the interval", () => {
    expect(isCatalystScanDue(null, at(13, 12, 0))).toBe(true);
    expect(isCatalystScanDue("not-a-date", at(13, 12, 0))).toBe(true);
    expect(isCatalystScanDue(new Date(at(13, 12, 0).getTime() - 5 * h).toISOString(), at(13, 12, 0))).toBe(true);
  });

  it("stays quiet inside the interval", () => {
    expect(isCatalystScanDue(new Date(at(13, 12, 0).getTime() - 3 * h).toISOString(), at(13, 12, 0))).toBe(false);
    expect(isCatalystScanDue(iso(at(13, 11, 59)), at(13, 12, 0))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/services/__tests__/persistence.test.ts`
Expected: FAIL — `isMaintenanceDue is not defined` (import error).

- [ ] **Step 3: Implement in `src/services/jobHealth.ts`**

Replace `isDailyJobDue` and `isMaintenanceCatchupDue` (keep them temporarily if scheduler.ts still imports them — final deletion happens with Task 4's rewire) and add:

```ts
/** Local calendar date key (YYYY-MM-DD) — lexicographic order == date order. */
const localDateKey = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * Is the daily maintenance due now? (roadmap #52) Anchored to the local
 * calendar day: due once past `dueHour` local until a run COMPLETES with
 * today's local date. The old ">20h since last run" anchor drifted later
 * every time a catch-up ran late (a 17:18 catch-up pushed the next due-time
 * to 13:18, past the machine's bedtime — 2026-07-12 was silently skipped).
 * A run killed mid-flight keeps yesterday's stamp, so it self-heals at the
 * next tick. An `error` completion stamps today, so a failing maintenance
 * retries tomorrow, not every minute (unchanged from #48). Pure.
 */
export function isMaintenanceDue(
  lastRunAt: string | null | undefined,
  now = new Date(),
  dueHour = 8,
): boolean {
  if (now.getHours() < dueHour) return false;
  if (!lastRunAt) return true;
  const t = new Date(lastRunAt);
  if (isNaN(t.getTime())) return true;
  return localDateKey(t) < localDateKey(now);
}

/**
 * Is the 4-hourly catalyst scan due now? (roadmap #52) The old cron
 * (`0 */4 * * 1-5`) only fired when the machine was awake at those exact
 * minutes and had no catch-up — it last ran Friday evening and then missed
 * a whole Monday. Interval-anchored: weekdays only, due when never run or
 * the last run is older than `intervalHours`. Pure.
 */
export function isCatalystScanDue(
  lastRunAt: string | null | undefined,
  now = new Date(),
  intervalHours = 4,
): boolean {
  const day = now.getDay();
  if (day === 0 || day === 6) return false;
  if (!lastRunAt) return true;
  const t = new Date(lastRunAt).getTime();
  return isNaN(t) || now.getTime() - t > intervalHours * 3600_000;
}
```

Update the persistence.test.ts import line to:

```ts
import { recordJobRun, getJobHealth, isMaintenanceDue, isCatalystScanDue } from "../jobHealth";
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/services/__tests__/persistence.test.ts`
Expected: PASS (old due-check tests replaced, new ones green).

Commit happens together with Task 4 (the old helpers can only be deleted once the scheduler stops importing them).

---

### Task 4: Scheduler rewire — drop node-cron (#52)

**Files:**
- Modify: `src/jobs/scheduler.ts`
- Modify: `src/services/jobHealth.ts` (delete `isDailyJobDue` + `isMaintenanceCatchupDue`)
- Modify: `package.json` (remove node-cron)

**Interfaces:**
- Consumes: `isMaintenanceDue`, `isCatalystScanDue` from Task 3.
- Produces: nothing downstream.

- [ ] **Step 1: Rewire `src/jobs/scheduler.ts`**

1. Delete `import cron from "node-cron";` (line 5).
2. Change the jobHealth import to `import { recordJobRun, getJobHealth, isMaintenanceDue, isCatalystScanDue } from "@/services/jobHealth";`
3. In `refreshLoop()`, replace the catch-up block (`const lastMaint … }` inside the try) with:

```ts
    // One trigger mechanism for every job (roadmap #52): the minute loop.
    // Cron ticks miss whenever the machine sleeps through the exact minute;
    // due-checks against the persisted last-run recover on the next tick.
    const health = getJobHealth().jobs;
    const lastMaint = health.find((j) => j.job === "daily_maintenance")?.lastRunAt;
    if (isMaintenanceDue(lastMaint)) {
      await runMaintenanceGuarded("due for today (08:00 local)");
    } else {
      // Skip the scan on maintenance ticks — dailyMaintenance already runs
      // scanYahooNews; back-to-back scans would double-fetch the same feeds.
      const lastScan = health.find((j) => j.job === "catalyst_scan")?.lastRunAt;
      if (isCatalystScanDue(lastScan)) {
        await catalystScan().catch((e) => {
          log(`catalyst scan failed: ${errorMessage(e)}`);
          recordJobRun("catalyst_scan", "error", errorMessage(e));
        });
      }
    }
```

(Note: the `.catch` fixes a latent crash — under cron, a throw from `rollCatalystStatuses()`/`generateAlerts()` inside `void catalystScan()` was an unhandled rejection, which kills modern Node.)

4. Delete both `cron.schedule(...)` lines and their comments.
5. Delete the whole `// Startup catch-up (roadmap #43)` block (the loop's first tick at boot covers it — `refreshLoop()` runs immediately).
6. Update the file-header comment (line 2): `// Market-state-aware refresh cadence + due-check-driven daily/4-hourly jobs (no cron: roadmap #52).`
7. Update the comment above `refreshLoop` that references node-cron to: `// Poll ~every minute; maybeRefresh self-throttles to the phase interval and the due-checks below gate the daily/4-hourly jobs. A self-scheduling timer survives machine sleep: on wake it fires once and reschedules.`

- [ ] **Step 2: Delete the dead helpers**

In `src/services/jobHealth.ts` delete `isDailyJobDue` and `isMaintenanceCatchupDue` entirely (nothing imports them now — confirm with `rg "isDailyJobDue|isMaintenanceCatchupDue" src/`; expect zero hits).

- [ ] **Step 3: Remove node-cron**

Run: `npm uninstall node-cron`
Expected: package.json + package-lock.json updated; `rg "node-cron" src/ package.json` → no hits (comments referencing it were rewritten in Step 1).

- [ ] **Step 4: Full check**

Run: `npm run typecheck && npm test`
Expected: clean.

- [ ] **Step 5: Verify live**

```powershell
Stop-ScheduledTask -TaskName FinanceAgentJobs; Start-ScheduledTask -TaskName FinanceAgentJobs
```

Then `Get-Content data\logs\jobs.log -Tail 30` after ~2 minutes. Expected within the first two ticks:
- heartbeat + refresh lines as usual, **no** `[NODE-CRON]` banner ever again;
- `catalyst_scan` fires (its last run is Friday — overdue) and `job_runs.catalyst_scan` updates: `node -e "const D=require('better-sqlite3');const db=new D('data/finance-agent.db',{readonly:true});console.log(db.prepare('SELECT job,last_run_at,status FROM job_runs').all())"`;
- maintenance does NOT re-run if it already completed today (calendar anchor), or runs if today's is still missing.

- [ ] **Step 6: Commit (Tasks 3+4 together)**

```bash
git add src/services/jobHealth.ts src/services/__tests__/persistence.test.ts src/jobs/scheduler.ts package.json package-lock.json
git commit -m "All jobs on minute-loop due-checks; drop node-cron (roadmap #52)" && git push
```

---

### Task 5: Yahoo browser fallback — investigate live, then fix or retire (#53)

**Files:**
- Create (temporary, deleted before commit): `scripts/probe-yahoo-browser.ts`
- Then EITHER fix: `src/services/yahooFinanceBrowser.ts` + `src/services/__tests__/yahooParser.test.ts`
- OR retire: `src/services/yahooHttp.ts`, `src/services/yahooFinanceBrowser.ts`, `src/services/__tests__/yahooParser.test.ts`, `README.md`, `src/app/status/page.tsx` + `src/services/status.ts` (the `yahooBrowserFallback` flag), possibly `src/services/catalysts.ts` (news-scan fallback)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `getYahooSummaryFields(ticker)` keeps its exact signature either way (callers in quotes.ts/fundamentals never change).

**Decision rule (from the spec):** fix if the page still carries the data and an extraction update reaches it; retire the browser *quote* path if the page is no longer reliably scrapable headless. Evaluate the three browser paths separately: (1) quote-page HTML parse, (2) earnings via in-page API fetch, (3) news-page scan. Only demonstrably-broken paths are retired. **If the evidence is ambiguous (e.g. intermittent consent walls), stop and ask the user before deleting anything.**

- [ ] **Step 1: Map the browser call sites**

Run: `rg -n "getYahooService|getQuotePage|getSummaryFields|\.getEarnings\(" src/`
Record every caller (known: `yahooHttp.getYahooSummaryFields` fallback, `yahooHttp.getYahooEarnings` fallback; expect a news-scan use in `catalysts.ts`).

- [ ] **Step 2: Write and run the probe**

Create `scripts/probe-yahoo-browser.ts`:

```ts
// TEMPORARY probe for roadmap #53 — delete before commit.
import { loadDotEnv } from "@/lib/loadEnv";
loadDotEnv();
import fs from "node:fs";
import { getYahooService, parseYahooQuoteHtml } from "@/services/yahooFinanceBrowser";

async function main() {
  const ticker = process.argv[2] ?? "AAPL";
  const svc = getYahooService();
  const page = await svc.getQuotePage(ticker);
  if (!page) {
    console.log("getQuotePage returned null (launch failure or nav error)");
    return;
  }
  console.log("url:", page.url, "html bytes:", page.html.length);
  console.log("fin-streamer tags:", (page.html.match(/<fin-streamer/gi) ?? []).length);
  console.log(
    "symbol-matched price tag present:",
    new RegExp(`data-symbol="${ticker}"[^>]*data-field="regularMarketPrice"`, "i").test(page.html),
  );
  console.log("consent/marker check:", /consent|guce\.yahoo/i.test(page.url) || /collectConsent/i.test(page.html));
  const fields = parseYahooQuoteHtml(page.html, ticker, page.url);
  console.log("parsed:", JSON.stringify(fields, null, 2));
  fs.writeFileSync(`data/probe-${ticker}.html`, page.html); // git-ignored dir
  console.log("--- earnings path ---");
  console.log("earnings rows:", (await svc.getEarnings(ticker)).length);
  await svc.close();
}
void main();
```

Run: `npx tsx scripts/probe-yahoo-browser.ts AAPL` and again with `MSFT`.
Record: does the HTML contain the ticker's `fin-streamer[data-field="regularMarketPrice"]`? Does `parseYahooQuoteHtml` find the price? Is there a consent redirect? Do earnings rows come back? Inspect `data/probe-AAPL.html` around the price markup to see what changed.

- [ ] **Step 3a (FIX branch — page carries the data, parser misses it):**

Adjust the extraction in `yahooFinanceBrowser.ts` to match the observed markup (e.g. the price element changed tag/attribute — update `finStreamerValue`'s regex or add the new attribute pattern alongside `data-value`/`value`). Then add a regression case to `src/services/__tests__/yahooParser.test.ts` with a MINIMAL HTML snippet copied from the live page (the price element and its real attributes, ~10 lines, not the whole page):

```ts
it("parses the 2026-07 Yahoo quote layout (roadmap #53)", () => {
  const html = `…minimal excerpt pasted from data/probe-AAPL.html…`;
  const f = parseYahooQuoteHtml(html, "AAPL", "https://finance.yahoo.com/quote/AAPL/");
  expect(f.regularPrice).toBeCloseTo(/* the live value seen in the probe */);
  expect(f.extractionErrors).toEqual([]);
});
```

Re-run the probe to confirm the live parse now returns a price. Run `npm run typecheck && npm test`.

- [ ] **Step 3b (RETIRE branch — page no longer scrapable):**

1. In `yahooHttp.ts` `getYahooSummaryFields`: remove the browser fallback — the function returns the HTTP result or null:

```ts
export async function getYahooSummaryFields(ticker: string): Promise<YahooSummaryFields | null> {
  try {
    const json = await quoteSummary(ticker, "price,summaryDetail");
    return json ? summaryFieldsFromQuoteSummary(json, ticker) : null;
  } catch {
    return null;
  }
}
```

2. If the probe showed `getEarnings` still works (it fetches Yahoo's JSON API from page context, not page HTML), KEEP the earnings fallback and the browser service. Delete only what the quote path exclusively used: `getSummaryFields`, `getQuotePage` (unless the news scan uses it — check Step 1's map), `parseYahooQuoteHtml` + its private helpers (`finStreamerValue`, `detectMarketState`, `extractCompanyName`, `extractRangeValue`) and their cases in `yahooParser.test.ts`. Keep `YahooSummaryFields`, `quoteFromSummaryFields`, `parseYahooEarnings` (the HTTP path uses all three).
3. Evaluate the news-page scan (path 3) with the same evidence standard before touching it; if it still returns headlines (or the RSS primary makes it moot), leave it.
4. Update README § "Market data & scoring" (the "headless-Chromium scraper kept only as a fallback" sentence) to reflect what remains; update the /status Integrations line (`yahooBrowserFallback`) if the browser layer no longer exists for quotes.
5. Run `npm run typecheck && npm test`.

- [ ] **Step 4: Clean up and verify live**

Delete `scripts/probe-yahoo-browser.ts` and `data/probe-*.html`. Restart the runner task (`Stop-ScheduledTask`/`Start-ScheduledTask -TaskName FinanceAgentJobs`) and confirm the next refresh logs NO `[yahoo-browser] … regularMarketPrice not found` lines.

- [ ] **Step 5: Commit (message records the decision)**

```bash
git add -A
git commit -m "Yahoo browser quote fallback: <fixed parser for new layout | retired dead quote path> (roadmap #53)" && git push
```

Also tick the #53 checkbox in `docs/ROADMAP.md` with a one-line note of which branch was taken and why (commit with Task 8 if preferred).

---

### Task 6: /status "Data sources" health card (#54)

**Files:**
- Create: `src/services/__tests__/status.test.ts`
- Modify: `src/services/status.ts`
- Modify: `src/app/status/page.tsx`

**Interfaces:**
- Consumes: `ingestion_runs.bySource` JSON (`{"sec-edgar":20,"gdelt":0}`), `market_price_snapshots.source`.
- Produces:
  - `ingestionSourceHealth(runs: { ranAt: string; bySource: string | null }[]): IngestionSourceHealth[]` — `runs` newest-first; `IngestionSourceHealth = { source: string; lastProducedAt: string | null; emptyStreak: number; lastRunAt: string | null }`
  - `AMBER_EMPTY_STREAK = 3` (exported const)
  - `StatusReport.sources: { ingestion: IngestionSourceHealth[]; quotes: { source: string; lastProducedAt: string }[] }`

- [ ] **Step 1: Write the failing tests**

Create `src/services/__tests__/status.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ingestionSourceHealth, schedulerEnvFromHeartbeat } from "../status";

const run = (ranAt: string, bySource: Record<string, number> | null | string) => ({
  ranAt,
  bySource: bySource == null ? null : typeof bySource === "string" ? bySource : JSON.stringify(bySource),
});

describe("ingestionSourceHealth (roadmap #54)", () => {
  it("counts the consecutive empty streak from the newest run", () => {
    const rows = ingestionSourceHealth([
      run("2026-07-12T03:00:00Z", { "sec-edgar": 20, gdelt: 0 }),
      run("2026-07-11T03:00:00Z", { "sec-edgar": 10, gdelt: 0 }),
      run("2026-07-10T03:00:00Z", { "sec-edgar": 5, gdelt: 0 }),
      run("2026-07-09T03:00:00Z", { "sec-edgar": 0, gdelt: 7 }),
    ]);
    const gdelt = rows.find((r) => r.source === "gdelt")!;
    expect(gdelt.emptyStreak).toBe(3);
    expect(gdelt.lastProducedAt).toBe("2026-07-09T03:00:00Z");
    expect(gdelt.lastRunAt).toBe("2026-07-12T03:00:00Z");
    const sec = rows.find((r) => r.source === "sec-edgar")!;
    expect(sec.emptyStreak).toBe(0);
    expect(sec.lastProducedAt).toBe("2026-07-12T03:00:00Z");
  });

  it("only counts runs that include the source (a disabled source doesn't grow a streak)", () => {
    const rows = ingestionSourceHealth([
      run("2026-07-12T03:00:00Z", { "sec-edgar": 3 }),
      run("2026-07-11T03:00:00Z", { "sec-edgar": 2, "ir-rss": 0 }),
      run("2026-07-10T03:00:00Z", { "sec-edgar": 1, "ir-rss": 4 }),
    ]);
    const ir = rows.find((r) => r.source === "ir-rss")!;
    expect(ir.emptyStreak).toBe(1); // the 07-12 run didn't include ir-rss
    expect(ir.lastProducedAt).toBe("2026-07-10T03:00:00Z");
    expect(ir.lastRunAt).toBe("2026-07-11T03:00:00Z");
  });

  it("tolerates null and unparseable bySource payloads", () => {
    const rows = ingestionSourceHealth([
      run("2026-07-12T03:00:00Z", null),
      run("2026-07-11T03:00:00Z", "{corrupt"),
      run("2026-07-10T03:00:00Z", { gdelt: 2 }),
    ]);
    expect(rows).toEqual([
      { source: "gdelt", lastProducedAt: "2026-07-10T03:00:00Z", emptyStreak: 0, lastRunAt: "2026-07-10T03:00:00Z" },
    ]);
  });

  it("returns [] when there are no runs", () => {
    expect(ingestionSourceHealth([])).toEqual([]);
  });
});

describe("schedulerEnvFromHeartbeat (existing behavior, now colocated)", () => {
  it("flags the web-has-alpaca / runner-doesn't mismatch", () => {
    expect(schedulerEnvFromHeartbeat("alpaca=off llm=on", true).alpacaMismatch).toBe(true);
    expect(schedulerEnvFromHeartbeat("alpaca=paper llm=on", true).alpacaMismatch).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/services/__tests__/status.test.ts`
Expected: FAIL — `ingestionSourceHealth` is not exported.

- [ ] **Step 3: Implement in `src/services/status.ts`**

Add below `schedulerEnvFromHeartbeat`:

```ts
// --- Data-source health (roadmap #54) ----------------------------------------
// GDELT 429-throttles silently: six straight runs with bySource gdelt=0 and
// zero errors looked, on /events, exactly like "nothing happened". Derive a
// per-source pulse from the run log so a dark source is visible on /status.

/** A source is flagged amber once this many recent runs produced nothing. */
export const AMBER_EMPTY_STREAK = 3;

export interface IngestionSourceHealth {
  source: string;
  /** ranAt of the newest run in which this source produced >0 items. */
  lastProducedAt: string | null;
  /** Consecutive newest-first runs (that included the source) producing 0. */
  emptyStreak: number;
  /** ranAt of the newest run that included this source at all. */
  lastRunAt: string | null;
}

/** Pure: `runs` must be ordered newest-first. Unparseable bySource is skipped. */
export function ingestionSourceHealth(
  runs: { ranAt: string; bySource: string | null }[],
): IngestionSourceHealth[] {
  const parsed = runs.flatMap((r) => {
    if (!r.bySource) return [];
    try {
      const counts = JSON.parse(r.bySource) as Record<string, number>;
      return counts && typeof counts === "object" ? [{ ranAt: r.ranAt, counts }] : [];
    } catch {
      return [];
    }
  });
  const sources = [...new Set(parsed.flatMap((p) => Object.keys(p.counts)))].sort();
  return sources.map((source) => {
    const mine = parsed.filter((p) => source in p.counts);
    let emptyStreak = 0;
    for (const p of mine) {
      if ((p.counts[source] ?? 0) > 0) break;
      emptyStreak++;
    }
    return {
      source,
      lastProducedAt: mine.find((p) => (p.counts[source] ?? 0) > 0)?.ranAt ?? null,
      emptyStreak,
      lastRunAt: mine[0]?.ranAt ?? null,
    };
  });
}
```

Extend `StatusReport` with:

```ts
  sources: {
    ingestion: IngestionSourceHealth[];
    quotes: { source: string; lastProducedAt: string }[];
  };
```

And in `getStatusReport`, before the return:

```ts
  const ingestionRows = db.all(
    sql`SELECT ran_at, by_source FROM ingestion_runs ORDER BY ran_at DESC LIMIT 20`,
  ) as { ran_at: string; by_source: string | null }[];
  const quoteSourceRows = db.all(
    sql`SELECT source, MAX(captured_at) AS last FROM market_price_snapshots GROUP BY source ORDER BY source`,
  ) as { source: string; last: string }[];
```

…and add to the returned object:

```ts
    sources: {
      ingestion: ingestionSourceHealth(
        ingestionRows.map((r) => ({ ranAt: r.ran_at, bySource: r.by_source })),
      ),
      quotes: quoteSourceRows.map((r) => ({ source: r.source, lastProducedAt: r.last })),
    },
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/services/__tests__/status.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the card to `src/app/status/page.tsx`**

Import `AMBER_EMPTY_STREAK` from `@/services/status`. Add a new `<section className="card">` INSIDE the existing `md:grid-cols-2` grid, after the Backups section:

```tsx
        <section className="card">
          <h2 className="card-title">Data sources</h2>
          {s.sources.ingestion.length === 0 ? (
            <p className="text-sm text-zinc-500">No ingestion runs recorded yet.</p>
          ) : (
            <table className="data-table">
              <thead>
                <tr><th>Ingestion source</th><th>Last produced</th><th>Empty streak</th></tr>
              </thead>
              <tbody>
                {s.sources.ingestion.map((src) => (
                  <tr key={src.source}>
                    <td>{src.source}</td>
                    <td>{fmtWhen(src.lastProducedAt)}</td>
                    <td>
                      {src.emptyStreak >= AMBER_EMPTY_STREAK ? (
                        <span className="text-amber-400" title="Nothing from this source in its most recent runs — it may be rate-limited or broken.">
                          {src.emptyStreak} runs dark
                        </span>
                      ) : (
                        <span className="text-zinc-500">{src.emptyStreak === 0 ? "producing" : `${src.emptyStreak}`}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {s.sources.quotes.length > 0 && (
            <>
              <h3 className="mt-3 text-xs font-semibold text-zinc-400">Quote transports</h3>
              <table className="data-table">
                <thead>
                  <tr><th>Transport</th><th>Last produced data</th></tr>
                </thead>
                <tbody>
                  {s.sources.quotes.map((q) => (
                    <tr key={q.source}>
                      <td>{q.source}</td>
                      <td>{fmtWhen(q.lastProducedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-1 text-[11px] text-zinc-600">
                A fallback transport that is never invoked legitimately goes stale — old is only
                a problem for the primary you expect to be active.
              </p>
            </>
          )}
        </section>
```

- [ ] **Step 6: Full check + live verify**

Run: `npm run typecheck && npm test`
Then with `npm run dev` running, open http://localhost:3000/status — the card must show `gdelt` with an amber "runs dark" streak matching the real ingestion_runs data (≥3), `sec-edgar` producing, and quote transports with real timestamps.

- [ ] **Step 7: Commit**

```bash
git add src/services/status.ts src/services/__tests__/status.test.ts src/app/status/page.tsx
git commit -m "/status Data sources card: per-source pulse + empty streaks (roadmap #54)" && git push
```

---

### Task 7: Dead-runner watchdog (#55)

**Files:**
- Create: `src/services/watchdogCheck.ts` (pure decision logic)
- Create: `src/services/__tests__/watchdogCheck.test.ts`
- Create: `src/jobs/watchdog.ts` (tsx entrypoint — note: spec said `scripts/watchdog.ts`; `src/jobs/` matches the scheduler's layout and keeps `@/` imports, record the deviation in the commit message)
- Create: `scripts/install-watchdog-task.ps1`, `scripts/uninstall-watchdog-task.ps1`
- Modify: `package.json` (add `"watchdog": "tsx src/jobs/watchdog.ts"` to scripts)
- Modify: `README.md` (watchdog subsection + Commands table rows)

**Interfaces:**
- Consumes: `getJobHealth()` from `@/services/jobHealth`; `sendDirectNotification(severity, message, subtitle, cfg?)` from `@/services/notifications`; `scripts/run-hidden.vbs` from Task 2.
- Produces:
  - `decideWatchdogAction(opts: { heartbeatAt: string | null; lastNotifiedAt: string | null; now?: Date; staleMinutes?: number; renotifyHours?: number }): { notify: boolean; clearState: boolean; message: string | null }`

- [ ] **Step 1: Write the failing tests**

Create `src/services/__tests__/watchdogCheck.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decideWatchdogAction } from "../watchdogCheck";

const now = new Date("2026-07-13T20:00:00Z");
const minAgo = (m: number) => new Date(now.getTime() - m * 60_000).toISOString();

describe("decideWatchdogAction (roadmap #55)", () => {
  it("stays silent and clears state while the heartbeat is fresh", () => {
    const d = decideWatchdogAction({ heartbeatAt: minAgo(3), lastNotifiedAt: minAgo(120), now });
    expect(d).toEqual({ notify: false, clearState: true, message: null });
  });

  it("notifies on a stale heartbeat with no prior notification", () => {
    const d = decideWatchdogAction({ heartbeatAt: minAgo(45), lastNotifiedAt: null, now });
    expect(d.notify).toBe(true);
    expect(d.clearState).toBe(false);
    expect(d.message).toMatch(/45 minutes/);
  });

  it("throttles: no repeat inside the renotify window", () => {
    const d = decideWatchdogAction({ heartbeatAt: minAgo(45), lastNotifiedAt: minAgo(120), now });
    expect(d.notify).toBe(false);
    expect(d.clearState).toBe(false);
  });

  it("re-notifies once the renotify window passes", () => {
    const d = decideWatchdogAction({ heartbeatAt: minAgo(600), lastNotifiedAt: minAgo(7 * 60), now });
    expect(d.notify).toBe(true);
  });

  it("never notifies when no heartbeat was ever recorded (fresh install)", () => {
    const d = decideWatchdogAction({ heartbeatAt: null, lastNotifiedAt: null, now });
    expect(d).toEqual({ notify: false, clearState: false, message: null });
  });

  it("treats an unparseable heartbeat as stale (something is wrong)", () => {
    const d = decideWatchdogAction({ heartbeatAt: "garbage", lastNotifiedAt: null, now });
    expect(d.notify).toBe(true);
  });

  it("respects the staleMinutes boundary", () => {
    expect(decideWatchdogAction({ heartbeatAt: minAgo(9), lastNotifiedAt: null, now }).notify).toBe(false);
    expect(decideWatchdogAction({ heartbeatAt: minAgo(11), lastNotifiedAt: null, now }).notify).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/services/__tests__/watchdogCheck.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/services/watchdogCheck.ts`**

```ts
// Pure decision core for the dead-runner watchdog (roadmap #55). Every other
// liveness surface (header badge, /status, alerts, ntfy pushes) is served by
// the very processes that are dead when the answer matters — observed
// 2026-07-13: runner down all market session, zero notice anywhere. A tiny
// scheduled task runs this check from outside the app.

export interface WatchdogDecision {
  notify: boolean;
  /** True when the heartbeat is healthy again — the state file should be wiped. */
  clearState: boolean;
  message: string | null;
}

export function decideWatchdogAction(opts: {
  heartbeatAt: string | null;
  /** From data/watchdog-state.json — when we last nagged, null = never. */
  lastNotifiedAt: string | null;
  now?: Date;
  staleMinutes?: number;
  renotifyHours?: number;
}): WatchdogDecision {
  const now = opts.now ?? new Date();
  const staleMinutes = opts.staleMinutes ?? 10;
  const renotifyHours = opts.renotifyHours ?? 6;

  // Never ran at all: a fresh install, not an outage — don't nag.
  if (opts.heartbeatAt == null) return { notify: false, clearState: false, message: null };

  const hb = new Date(opts.heartbeatAt).getTime();
  const ageMin = isNaN(hb) ? Infinity : (now.getTime() - hb) / 60_000;
  if (ageMin <= staleMinutes) return { notify: false, clearState: true, message: null };

  const lastNotified = opts.lastNotifiedAt ? new Date(opts.lastNotifiedAt).getTime() : NaN;
  const sinceNotifyH = isNaN(lastNotified) ? Infinity : (now.getTime() - lastNotified) / 3600_000;
  if (sinceNotifyH < renotifyHours) return { notify: false, clearState: false, message: null };

  const ageText = Number.isFinite(ageMin)
    ? ageMin >= 120
      ? `${Math.round(ageMin / 60)} hours`
      : `${Math.round(ageMin)} minutes`
    : "unreadably";
  return {
    notify: true,
    clearState: false,
    message:
      `Job runner heartbeat is ${ageText} old — background refreshes, alerts, and maintenance are DOWN. ` +
      `Start it: Start-ScheduledTask -TaskName FinanceAgentJobs (or npm run jobs).`,
  };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/services/__tests__/watchdogCheck.test.ts`
Expected: 7 passed.

- [ ] **Step 5: Write the entrypoint `src/jobs/watchdog.ts`**

```ts
// Dead-runner watchdog entrypoint (roadmap #55): run by the FinanceAgentWatchdog
// scheduled task every 30 minutes. Checks the scheduler heartbeat from OUTSIDE
// the app and pushes a notification when it's stale. Exits 0 always — a
// "failing" watchdog task would just spam Task Scheduler restart logic.
import { loadDotEnv } from "@/lib/loadEnv";
loadDotEnv(); // #40 rule: tsx entrypoints don't get .env for free
import fs from "node:fs";
import path from "node:path";
import { nowIso } from "@/lib/util";

const STATE_PATH = path.resolve(process.cwd(), "data", "watchdog-state.json");

async function main(): Promise<void> {
  const dbFile = path.resolve(process.cwd(), process.env.DATABASE_PATH || "./data/finance-agent.db");
  if (!fs.existsSync(dbFile)) return; // app never set up here — nothing to watch

  // Import AFTER the existence check: getDb() would otherwise CREATE an empty
  // database (and run migrations) on a machine that never had one.
  const { getJobHealth } = await import("@/services/jobHealth");
  const { decideWatchdogAction } = await import("@/services/watchdogCheck");

  let lastNotifiedAt: string | null = null;
  try {
    lastNotifiedAt =
      (JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as { lastNotifiedAt?: string })
        .lastNotifiedAt ?? null;
  } catch {
    /* missing/corrupt state = never notified */
  }

  const heartbeatAt =
    getJobHealth().jobs.find((j) => j.job === "heartbeat")?.lastRunAt ?? null;
  // WATCHDOG_STALE_MINUTES: live-testing override (e.g. 0 forces "stale" now).
  const staleMinutes = Number.parseInt(process.env.WATCHDOG_STALE_MINUTES ?? "", 10);
  const decision = decideWatchdogAction({
    heartbeatAt,
    lastNotifiedAt,
    ...(Number.isFinite(staleMinutes) ? { staleMinutes } : {}),
  });

  if (decision.clearState) {
    try {
      fs.unlinkSync(STATE_PATH);
    } catch {
      /* already clear */
    }
    return;
  }
  if (!decision.notify || !decision.message) return;

  // Installing the watchdog task IS the opt-in for this message, so it goes
  // through the direct path (severity gate bypassed), like the channel test
  // and morning brief. Desktop toast needs no config; ntfy needs a topic.
  const { sendDirectNotification } = await import("@/services/notifications");
  await sendDirectNotification("critical", decision.message, "Runner down");
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify({ lastNotifiedAt: nowIso() }));
  console.log(`[watchdog ${nowIso()}] notified: ${decision.message}`);
}

void main().catch((e) => {
  console.error(`[watchdog] check failed:`, e);
  process.exit(0); // never a task failure
});
```

Add to `package.json` scripts: `"watchdog": "tsx src/jobs/watchdog.ts",` (after `"jobs"`).

- [ ] **Step 6: Write the installers**

`scripts/install-watchdog-task.ps1`:

```powershell
<#
.SYNOPSIS
  Register a Windows Scheduled Task that checks the Finance Agent job runner's
  heartbeat every 30 minutes and sends a notification when it is down.

.DESCRIPTION
  Every in-app liveness surface (header badge, /status, alert pushes) is served
  by the processes that are dead exactly when you need the warning. This task
  runs `npm run watchdog` from outside the app: if the scheduler heartbeat is
  >10 minutes old it pushes a desktop toast (and ntfy, if a topic is configured
  in Settings), throttled to one alert per outage with a 6h repeat.

  Opt-in: nothing installs this for you — you run it yourself. Remove it any
  time with scripts/uninstall-watchdog-task.ps1.
#>

$ErrorActionPreference = "Stop"

$TaskName = "FinanceAgentWatchdog"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
New-Item -ItemType Directory -Force -Path (Join-Path $ProjectRoot "data\logs") | Out-Null

$vbs = Join-Path $PSScriptRoot "run-hidden.vbs"
$action = New-ScheduledTaskAction -Execute "wscript.exe" `
    -Argument "`"$vbs`" watchdog data\logs\watchdog.log" -WorkingDirectory $ProjectRoot

# Every 30 minutes, indefinitely, starting a minute from now.
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 30) -RepetitionDuration ([TimeSpan]::MaxValue)
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

try {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
        -Settings $settings -Principal $principal `
        -Description "Finance Agent dead-runner watchdog (npm run watchdog every 30 min). Logs to data/logs/watchdog.log." `
        -Force -ErrorAction Stop | Out-Null
} catch {
    Write-Error "Failed to register '$TaskName': $($_.Exception.Message). Try running this from an elevated PowerShell."
    exit 1
}
if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
    Write-Error "Registration reported no error but '$TaskName' does not exist. Run this from an elevated PowerShell."
    exit 1
}

Write-Host "Registered scheduled task '$TaskName'." -ForegroundColor Green
Write-Host "  - Checks the runner heartbeat every 30 minutes (hidden window)"
Write-Host "  - Desktop toast works out of the box; add an ntfy topic in Settings for phone push"
Write-Host "  - Remove it: scripts\uninstall-watchdog-task.ps1"
```

`scripts/uninstall-watchdog-task.ps1`:

```powershell
<#
.SYNOPSIS
  Remove the Finance Agent watchdog Scheduled Task registered by
  scripts/install-watchdog-task.ps1.
#>

$ErrorActionPreference = "Stop"

$TaskName = "FinanceAgentWatchdog"

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $existing) {
    Write-Host "Task '$TaskName' is not registered — nothing to remove."
    return
}

try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch {}
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false

Write-Host "Removed scheduled task '$TaskName'." -ForegroundColor Green
```

- [ ] **Step 7: README**

Commands table: add rows for `npm run watchdog` ("one heartbeat check; notifies if the job runner is down — normally run by the watchdog task") and `scripts/install-watchdog-task.ps1` ("(Windows, opt-in) register a task that runs the watchdog every 30 min; `uninstall-watchdog-task.ps1` removes it").

After the "Keeping the scheduler running (Windows)" section, add:

```markdown
### Knowing when the scheduler dies

The header badge and /status only help while you're looking at the app. The
opt-in **watchdog task** watches from outside it: every 30 minutes it checks
the scheduler heartbeat in the database and, if it's more than 10 minutes
old, sends a desktop toast (plus ntfy push, if you configured a topic in
Settings) — one alert per outage, repeated every 6 hours while it stays down.

    scripts\install-watchdog-task.ps1      # register (runs `npm run watchdog` every 30 min)
    scripts\uninstall-watchdog-task.ps1    # remove it
```

- [ ] **Step 8: Full check + live verify**

Run: `npm run typecheck && npm test` → clean.

Live:
1. Runner task running → `npm run watchdog` → silent, exits 0, no `data/watchdog-state.json`.
2. Force staleness without waiting: `$env:WATCHDOG_STALE_MINUTES = '0'; npm run watchdog` → the heartbeat (~1 min old) counts as stale → **desktop toast appears** with the "Runner down" title; `data/watchdog-state.json` now exists. Run it again with the same env → silent (6h throttle). `Remove-Item Env:WATCHDOG_STALE_MINUTES`.
3. `npm run watchdog` (normal threshold, runner alive) → clears the state file.
4. `powershell -ExecutionPolicy Bypass -File scripts\install-watchdog-task.ps1` → registered; `Get-ScheduledTask -TaskName FinanceAgentWatchdog` → Ready, next run within 30 min; after its first scheduled run, `data\logs\watchdog.log` exists.

- [ ] **Step 9: Commit**

```bash
git add src/services/watchdogCheck.ts src/services/__tests__/watchdogCheck.test.ts src/jobs/watchdog.ts scripts/install-watchdog-task.ps1 scripts/uninstall-watchdog-task.ps1 package.json README.md
git commit -m "Dead-runner watchdog: heartbeat check task + direct notification (roadmap #55; entrypoint in src/jobs per repo layout)" && git push
```

---

### Task 8: Close out — roadmap ticks, docs, final verification

**Files:**
- Modify: `docs/ROADMAP.md` (tick #51–#55 with done-notes; #53's note records fix-vs-retire and why)
- Modify: `docs/agent-memory.md` (2026-07-13 session entry: what shipped, live observations, any new gotchas)

**Interfaces:** none.

- [ ] **Step 1: Tick the roadmap**

Mark #51–#55 `[x]` with the v5-style done-note format: *(size — done 2026-07-13; one-line live observation)*. #53's note MUST state which branch was taken and the probe evidence in one sentence.

- [ ] **Step 2: Handoff entry**

Add a `## 2026-07-13 session — roadmap v6 (#51–#55)` section to `docs/agent-memory.md` in the established style: the forensic findings (task killed at logon 0xC000013A, catalyst_scan gap, 20h drift, browser rot, gdelt dark), what shipped per item, live-verification results, and any gotchas discovered during the work.

- [ ] **Step 3: Final verification sweep**

```bash
npm run typecheck && npm test && npm run build
```

Expected: all clean (build matters — status page and README changed; catch any server-component slip).

Live end-state checklist:
- `Get-ScheduledTask FinanceAgentJobs` → Running, hidden; heartbeat fresh in DB.
- `Get-ScheduledTask FinanceAgentWatchdog` → Ready with a next-run time.
- `job_runs` shows today's `daily_maintenance` and a recent `catalyst_scan`.
- /status shows the Data sources card with real values.
- `data/logs/jobs.log` free of `[NODE-CRON]` and `[yahoo-browser] … not found` lines since the restart.

- [ ] **Step 4: Commit + push**

```bash
git add docs/ROADMAP.md docs/agent-memory.md
git commit -m "Roadmap v6 (#51-#55) complete: ticks + 2026-07-13 handoff entry" && git push
```
