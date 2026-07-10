import { describe, expect, it } from "vitest";
import { getDb, schema } from "@/db";
import { useTestDb } from "./dbHarness";
import { backfillHoldingSectors, sectorFromAssetProfile } from "../sectors";
import { generateAlerts } from "../alerts";

useTestDb();

describe("sectorFromAssetProfile", () => {
  it("extracts the sector from a quoteSummary payload", () => {
    const json = { quoteSummary: { result: [{ assetProfile: { sector: "Technology" } }] } };
    expect(sectorFromAssetProfile(json)).toBe("Technology");
  });

  it("returns null for missing, empty, or malformed payloads", () => {
    expect(sectorFromAssetProfile(null)).toBeNull();
    expect(sectorFromAssetProfile({})).toBeNull();
    expect(sectorFromAssetProfile({ quoteSummary: { result: [{}] } })).toBeNull();
    expect(
      sectorFromAssetProfile({ quoteSummary: { result: [{ assetProfile: { sector: "  " } }] } }),
    ).toBeNull();
  });
});

const holding = (ticker: string, marketValue: number, sector: string | null = null) =>
  getDb()
    .insert(schema.portfolioHoldings)
    .values({
      ticker,
      shares: 1,
      averageCost: marketValue,
      marketValue,
      sector,
      source: "manual",
      updatedAt: new Date().toISOString(),
    })
    .run();

describe("backfillHoldingSectors (roadmap #37)", () => {
  it("fills only the holdings missing a sector; unresolved stay null", async () => {
    holding("MSFT", 1000); // missing → fetched
    holding("XOM", 1000, "Energy"); // already set → not re-fetched
    holding("MYSTERY", 1000); // fetcher can't resolve → stays null

    const fetched: string[] = [];
    const res = await backfillHoldingSectors(async (t) => {
      fetched.push(t);
      return t === "MSFT" ? "Technology" : null;
    });

    expect(res).toEqual({ checked: 2, filled: 1 });
    expect(fetched.sort()).toEqual(["MSFT", "MYSTERY"]);
    const rows = getDb().select().from(schema.portfolioHoldings).all();
    const byTicker = new Map(rows.map((h) => [h.ticker, h.sector]));
    expect(byTicker.get("MSFT")).toBe("Technology");
    expect(byTicker.get("XOM")).toBe("Energy");
    expect(byTicker.get("MYSTERY")).toBeNull();
  });
});

describe("sector concentration alerts (roadmap #30 + #37)", () => {
  it("fires the sector warning once real sectors exist", () => {
    // Three 15% Tech positions (each under the 20% position cap) total 45% —
    // past the default 35% sector cap; the rest spread across four sectors.
    for (const t of ["AAA", "BBB", "CCC"]) holding(t, 1500, "Technology");
    holding("DDD", 1375, "Energy");
    holding("EEE", 1375, "Healthcare");
    holding("FFF", 1375, "Utilities");
    holding("GGG", 1375, "Financial Services");

    generateAlerts();
    const conc = getDb()
      .select()
      .from(schema.alerts)
      .all()
      .filter((a) => a.alertType === "concentration");
    expect(conc).toHaveLength(1);
    expect(conc[0].message).toMatch(/Technology sector is 45% of the account \(cap 35%\)/);
  });
});
