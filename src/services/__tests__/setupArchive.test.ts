import { describe, expect, it } from "vitest";
import { getDb, schema } from "@/db";
import { useTestDb } from "./dbHarness";
import { activeSetups } from "@/lib/queries";
import {
  archiveSetup,
  unarchiveSetup,
  updateArchiveNote,
  listArchivedSetups,
  suppressedSetupPairs,
  clearEndedSuppressions,
  pairKey,
} from "../setupArchive";

useTestDb();

const insertSetup = (ticker: string, setupType = "breakout", quality = 7) =>
  getDb()
    .insert(schema.tradeSetups)
    .values({
      ticker,
      setupType,
      setupQualityScore: quality,
      entryRangeLow: 100,
      entryRangeHigh: 105,
      stopLoss: 95,
      targetPrice1: 115,
      targetPrice2: 125,
      riskRewardRatio: 3,
      invalidationCondition: "close below 95",
      detectedAt: "2026-07-16T18:00:00.000Z",
      status: "active",
    })
    .returning()
    .get();

describe("setupArchive (swing archive spec 2026-07-16)", () => {
  it("archive snapshots every field and suppresses the pair", () => {
    const s = insertSetup("NVDA");
    const a = archiveSetup(s.id, "wait for earnings");
    expect(a).not.toBeNull();
    expect(a!.ticker).toBe("NVDA");
    expect(a!.setupType).toBe("breakout");
    expect(a!.entryRangeLow).toBe(100);
    expect(a!.entryRangeHigh).toBe(105);
    expect(a!.stopLoss).toBe(95);
    expect(a!.targetPrice1).toBe(115);
    expect(a!.targetPrice2).toBe(125);
    expect(a!.riskRewardRatio).toBe(3);
    expect(a!.invalidationCondition).toBe("close below 95");
    expect(a!.detectedAt).toBe("2026-07-16T18:00:00.000Z");
    expect(a!.note).toBe("wait for earnings");
    expect(a!.suppressing).toBe(true);
    expect(suppressedSetupPairs().has(pairKey("NVDA", "breakout"))).toBe(true);
  });

  it("returns null for a vanished setup id", () => {
    expect(archiveSetup(99999)).toBeNull();
  });

  it("is idempotent per pair while suppressing (no duplicate; note updates)", () => {
    const s1 = insertSetup("AAPL");
    const first = archiveSetup(s1.id, "v1");
    const s2 = insertSetup("AAPL"); // next scan's re-detection row
    const second = archiveSetup(s2.id, "v2");
    expect(second!.id).toBe(first!.id);
    expect(second!.note).toBe("v2");
    expect(listArchivedSetups().filter((r) => r.ticker === "AAPL")).toHaveLength(1);
  });

  it("activeSetups hides suppressed pairs and shows everything else", () => {
    const a = insertSetup("MSFT");
    insertSetup("MSFT", "pullback");
    insertSetup("TSLA");
    archiveSetup(a.id);
    const shown = activeSetups().map((s) => pairKey(s.ticker, s.setupType));
    expect(shown).not.toContain(pairKey("MSFT", "breakout"));
    expect(shown).toContain(pairKey("MSFT", "pullback"));
    expect(shown).toContain(pairKey("TSLA", "breakout"));
  });

  it("clearEndedSuppressions flips only pairs absent from the detected set", () => {
    archiveSetup(insertSetup("NVDA").id);
    archiveSetup(insertSetup("AMD").id);
    const cleared = clearEndedSuppressions(new Set([pairKey("NVDA", "breakout")]));
    expect(cleared).toBe(1); // AMD's episode ended
    const pairs = suppressedSetupPairs();
    expect(pairs.has(pairKey("NVDA", "breakout"))).toBe(true);
    expect(pairs.has(pairKey("AMD", "breakout"))).toBe(false);
    // AMD's snapshot is kept as history and a NEW episode lists again.
    expect(listArchivedSetups().some((r) => r.ticker === "AMD")).toBe(true);
    insertSetup("AMD");
    expect(activeSetups().some((s) => s.ticker === "AMD")).toBe(true);
  });

  it("unarchive deletes the snapshot and the pair reappears", () => {
    const s = insertSetup("META");
    const a = archiveSetup(s.id)!;
    expect(activeSetups().some((r) => r.ticker === "META")).toBe(false);
    expect(unarchiveSetup(a.id)).toBe(true);
    expect(unarchiveSetup(a.id)).toBe(false); // already gone
    expect(listArchivedSetups().some((r) => r.ticker === "META")).toBe(false);
    expect(activeSetups().some((r) => r.ticker === "META")).toBe(true);
  });

  it("note round-trip; empty string clears to null; newest-first list order", () => {
    const a1 = archiveSetup(insertSetup("F").id)!;
    const a2 = archiveSetup(insertSetup("GE").id)!;
    expect(updateArchiveNote(a1.id, "re-check next week")).toBe(true);
    expect(updateArchiveNote(a1.id, "  ")).toBe(true);
    const rows = listArchivedSetups();
    expect(rows.find((r) => r.id === a1.id)!.note).toBeNull();
    expect(updateArchiveNote(99999, "x")).toBe(false);
    // a2 archived after a1 → listed first (archivedAt desc, id desc tiebreak).
    expect(rows.findIndex((r) => r.id === a2.id)).toBeLessThan(rows.findIndex((r) => r.id === a1.id));
  });
});
