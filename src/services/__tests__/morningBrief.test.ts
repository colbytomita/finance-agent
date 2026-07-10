import { describe, expect, it } from "vitest";
import { getDb, schema } from "@/db";
import { useTestDb } from "./dbHarness";
import { buildMorningBrief, sendMorningBrief } from "../morningBrief";
import { upsertUpcomingEarningsCatalyst } from "../catalysts";
import { saveConfig } from "@/lib/config";

useTestDb();

const now = () => new Date().toISOString();
const inDays = (d: number) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

function seedBusyDay() {
  const db = getDb();
  db.insert(schema.activeTrades)
    .values({
      ticker: "GE",
      direction: "long",
      entryPrice: 100,
      entryDate: now(),
      shares: 5,
      currentPrice: 96,
      tradeScore: 3.9,
      recommendation: "Exit",
      status: "open",
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  db.insert(schema.watchlistItems)
    .values({ ticker: "DIS", targetBuyLow: 80, targetBuyHigh: 90, createdAt: now(), updatedAt: now() })
    .run();
  db.insert(schema.drawdownMetrics)
    .values({
      ticker: "DIS",
      currentPrice: 85,
      buyZoneStatus: "In Buy Zone",
      calculatedAt: now(),
    })
    .run();
  upsertUpcomingEarningsCatalyst("LLY", inDays(2));
  db.insert(schema.tradeSetups)
    .values({
      ticker: "BAC",
      setupType: "breakout",
      setupQualityScore: 7.5,
      entryRangeLow: 40,
      entryRangeHigh: 41,
      stopLoss: 38,
      targetPrice1: 46,
      riskRewardRatio: 2.5,
      detectedAt: now(),
      status: "active",
    })
    .run();
}

describe("buildMorningBrief (roadmap #39)", () => {
  it("composes all sections from current state", () => {
    seedBusyDay();
    const b = buildMorningBrief(new Date("2026-07-10T12:00:00Z"));
    expect(b.message).toContain("Morning brief 2026-07-10");
    expect(b.message).toMatch(/Needs attention: GE Exit \(score 3\.9\)/);
    expect(b.message).toMatch(/Earnings soon: LLY in \dd/);
    expect(b.message).toMatch(/In buy zone: DIS/);
    expect(b.message).toMatch(/Setups: BAC breakout \(q7\.5\)/);
  });

  it("omits empty sections on a quiet day", () => {
    const b = buildMorningBrief();
    expect(b.lines).toHaveLength(1); // just the regime line
    expect(b.message).not.toMatch(/Needs attention|Earnings soon|In buy zone|Setups:/);
  });
});

describe("sendMorningBrief", () => {
  it("is off unless enabled, and idempotent per day when on", async () => {
    expect(await sendMorningBrief()).toEqual({ sent: false, reason: "disabled" });

    saveConfig({ morningBriefEnabled: true });
    expect((await sendMorningBrief()).reason).toBe("sent");
    expect((await sendMorningBrief()).reason).toBe("already-sent-today");

    const briefs = getDb()
      .select()
      .from(schema.alerts)
      .all()
      .filter((a) => a.alertType === "morning_brief");
    expect(briefs).toHaveLength(1);
    expect(briefs[0].severity).toBe("info");
  });
});
