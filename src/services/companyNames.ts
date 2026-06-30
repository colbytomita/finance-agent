import { eq, isNull, like, or } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { getTickerNameMap } from "./sources/cikMap";

// Backfill missing company names on tracked rows from SEC's authoritative
// ticker->name map. Real names power higher-precision GDELT auto-queries (a bare
// quoted name beats a bare ticker) and render in the watchlist/holdings/picks
// UI. One cheap, cached bulk SEC fetch — no per-ticker calls. Tickers not in the
// map (foreign listings, most ETFs) are simply left blank. Real data only.
//
// It also repairs any stored name that still carries a SEC state-of-incorporation
// artifact (a stray "/", as in "BANK OF AMERICA CORP /DE/") — legitimate company
// names never contain a slash, so matching on it is safe and self-healing.

export interface NameBackfillResult {
  scanned: number; // tracked rows missing a company name
  resolved: number; // rows we filled in
  byTable: Record<string, number>;
  mapSize: number; // SEC map size (0 => fetch failed; nothing resolved)
  dryRun: boolean;
}

/** Apply resolved names to one table's missing-name rows (or count them, when dry). */
function applyNames(
  label: string,
  rows: { id: number; ticker: string }[],
  update: (id: number, name: string) => void,
  nameMap: Map<string, string>,
  result: NameBackfillResult,
  dryRun: boolean,
): void {
  for (const r of rows) {
    result.scanned++;
    const name = nameMap.get(r.ticker.toUpperCase());
    if (!name) continue;
    if (!dryRun) update(r.id, name);
    result.resolved++;
    result.byTable[label] = (result.byTable[label] ?? 0) + 1;
  }
}

/**
 * Fill in `companyName` wherever it's missing across the tracked tables. Pass
 * `dryRun` to report what would resolve without writing. Returns a summary.
 */
export async function backfillCompanyNames(
  opts: { fetchFn?: typeof fetch; dryRun?: boolean } = {},
): Promise<NameBackfillResult> {
  const dryRun = opts.dryRun ?? false;
  const nameMap = await getTickerNameMap({ fetchFn: opts.fetchFn, userAgent: process.env.SEC_USER_AGENT });
  const db = getDb();
  const result: NameBackfillResult = {
    scanned: 0,
    resolved: 0,
    byTable: {},
    mapSize: nameMap.size,
    dryRun,
  };
  if (nameMap.size === 0) return result; // SEC fetch failed — don't touch anything

  const w = schema.watchlistItems;
  applyNames(
    "watchlist",
    db
      .select({ id: w.id, ticker: w.ticker })
      .from(w)
      .where(or(isNull(w.companyName), eq(w.companyName, ""), like(w.companyName, "%/%")))
      .all(),
    (id, name) => db.update(w).set({ companyName: name }).where(eq(w.id, id)).run(),
    nameMap,
    result,
    dryRun,
  );

  const h = schema.portfolioHoldings;
  applyNames(
    "holdings",
    db
      .select({ id: h.id, ticker: h.ticker })
      .from(h)
      .where(or(isNull(h.companyName), eq(h.companyName, ""), like(h.companyName, "%/%")))
      .all(),
    (id, name) => db.update(h).set({ companyName: name }).where(eq(h.id, id)).run(),
    nameMap,
    result,
    dryRun,
  );

  const a = schema.agentCandidates;
  applyNames(
    "agentPicks",
    db
      .select({ id: a.id, ticker: a.ticker })
      .from(a)
      .where(or(isNull(a.companyName), eq(a.companyName, ""), like(a.companyName, "%/%")))
      .all(),
    (id, name) => db.update(a).set({ companyName: name }).where(eq(a.id, id)).run(),
    nameMap,
    result,
    dryRun,
  );

  const s = schema.sectorScoutPicks;
  applyNames(
    "sectorPicks",
    db
      .select({ id: s.id, ticker: s.ticker })
      .from(s)
      .where(or(isNull(s.companyName), eq(s.companyName, ""), like(s.companyName, "%/%")))
      .all(),
    (id, name) => db.update(s).set({ companyName: name }).where(eq(s.id, id)).run(),
    nameMap,
    result,
    dryRun,
  );

  return result;
}
