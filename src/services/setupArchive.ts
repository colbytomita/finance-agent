import { and, desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { nowIso } from "@/lib/util";

// User-curated archive of recommended swing setups (spec 2026-07-16).
// Archive = snapshot + hide: the snapshot lives here (immune to trade_setups
// retention), and `suppressing` hides the (ticker, setupType) pair from the
// live Recommended table while the scanner keeps re-detecting it. The scan
// itself ends suppression (clearEndedSuppressions) when the pair drops out —
// a later NEW episode lists normally. trade_setups keeps recording detections
// throughout, so the setup-outcome backtest never loses data.

export type ArchivedSetup = typeof schema.archivedSetups.$inferSelect;

export const pairKey = (ticker: string, setupType: string): string =>
  `${ticker.toUpperCase()}|${setupType}`;

const cleanNote = (note: string | undefined): string | null => {
  const t = note?.trim();
  return t ? t : null;
};

/** Snapshot + suppress. Idempotent per pair while suppressing. Null = no such setup. */
export function archiveSetup(setupId: number, note?: string): ArchivedSetup | null {
  const db = getDb();
  const s = db.select().from(schema.tradeSetups).where(eq(schema.tradeSetups.id, setupId)).get();
  if (!s) return null;
  const existing = db
    .select()
    .from(schema.archivedSetups)
    .where(
      and(
        eq(schema.archivedSetups.ticker, s.ticker),
        eq(schema.archivedSetups.setupType, s.setupType),
        eq(schema.archivedSetups.suppressing, true),
      ),
    )
    .get();
  if (existing) {
    if (note !== undefined) {
      db.update(schema.archivedSetups)
        .set({ note: cleanNote(note) })
        .where(eq(schema.archivedSetups.id, existing.id))
        .run();
      return { ...existing, note: cleanNote(note) };
    }
    return existing;
  }
  return db
    .insert(schema.archivedSetups)
    .values({
      ticker: s.ticker,
      setupType: s.setupType,
      setupQualityScore: s.setupQualityScore,
      entryRangeLow: s.entryRangeLow,
      entryRangeHigh: s.entryRangeHigh,
      stopLoss: s.stopLoss,
      targetPrice1: s.targetPrice1,
      targetPrice2: s.targetPrice2,
      riskRewardRatio: s.riskRewardRatio,
      invalidationCondition: s.invalidationCondition,
      detectedAt: s.detectedAt,
      archivedAt: nowIso(),
      note: cleanNote(note),
      suppressing: true,
    })
    .returning()
    .get();
}

/** Delete the snapshot; the pair may list again immediately if still detected. */
export function unarchiveSetup(id: number): boolean {
  const res = getDb().delete(schema.archivedSetups).where(eq(schema.archivedSetups.id, id)).run();
  return res.changes > 0;
}

export function updateArchiveNote(id: number, note: string): boolean {
  const res = getDb()
    .update(schema.archivedSetups)
    .set({ note: cleanNote(note) })
    .where(eq(schema.archivedSetups.id, id))
    .run();
  return res.changes > 0;
}

export function listArchivedSetups(): ArchivedSetup[] {
  return getDb()
    .select()
    .from(schema.archivedSetups)
    .orderBy(desc(schema.archivedSetups.archivedAt), desc(schema.archivedSetups.id))
    .all();
}

/** Pairs currently hidden from the live Recommended table. */
export function suppressedSetupPairs(): Set<string> {
  const rows = getDb()
    .select({ ticker: schema.archivedSetups.ticker, setupType: schema.archivedSetups.setupType })
    .from(schema.archivedSetups)
    .where(eq(schema.archivedSetups.suppressing, true))
    .all();
  return new Set(rows.map((r) => pairKey(r.ticker, r.setupType)));
}

/**
 * Called by scanForSetups with the pairs the scan just detected. Any
 * suppressing archive row whose pair was NOT re-detected has reached the end
 * of its episode: stop suppressing (the snapshot stays as history). Never
 * throws — a failure here must not break the refresh.
 */
export function clearEndedSuppressions(detectedPairs: Set<string>): number {
  try {
    const db = getDb();
    const rows = db
      .select()
      .from(schema.archivedSetups)
      .where(eq(schema.archivedSetups.suppressing, true))
      .all();
    let cleared = 0;
    for (const r of rows) {
      if (!detectedPairs.has(pairKey(r.ticker, r.setupType))) {
        db.update(schema.archivedSetups)
          .set({ suppressing: false })
          .where(eq(schema.archivedSetups.id, r.id))
          .run();
        cleared++;
      }
    }
    return cleared;
  } catch {
    return 0;
  }
}
