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
