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
