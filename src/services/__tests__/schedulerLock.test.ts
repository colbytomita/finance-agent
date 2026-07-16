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
