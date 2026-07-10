import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { Confidence } from "@/lib/types";
import type { CatalystInput } from "./scoring";
import { errorMessage, mapPool, nowIso } from "@/lib/util";

/** Bounded Yahoo concurrency for the maintenance fetch loops (roadmap #46). */
const EARNINGS_FETCH_CONCURRENCY = 4;

// Quarterly earnings surprise (beat / meet / miss) as a scoring signal. The pure
// math here (surprise %, impact mapping, recency decay) is unit-tested and feeds
// the stock score via getCatalystInputs — a beat behaves like a positive catalyst,
// a miss like a negative one — so it flows through catalyst/sentiment/risk and the
// usual "why" reasons without a bespoke component.

export type EarningsRow = typeof schema.earningsReports.$inferSelect;

/** EPS surprise as a percent of the (absolute) estimate. Null when not computable. */
export function computeSurprisePercent(
  epsEstimate: number | null | undefined,
  epsActual: number | null | undefined,
): number | null {
  if (epsEstimate == null || epsActual == null || !isFinite(epsEstimate) || !isFinite(epsActual)) {
    return null;
  }
  if (epsEstimate === 0) return null; // a 0 estimate has no meaningful percent surprise
  return ((epsActual - epsEstimate) / Math.abs(epsEstimate)) * 100;
}

export type SurpriseClass = "beat" | "inline" | "miss";

/** Classify a surprise %: within ±2% counts as in line. */
export function classifySurprise(surprisePct: number | null | undefined): SurpriseClass {
  if (surprisePct == null || Math.abs(surprisePct) <= 2) return "inline";
  return surprisePct > 0 ? "beat" : "miss";
}

/**
 * Map an EPS surprise % to a signed -5..+5 impact. Diminishing returns: a small
 * beat nudges, a blowout saturates near ±5. Anything within ~2% is "in line" → 0.
 *   +5% ≈ +1.2 · +10% ≈ +2.2 · +20% ≈ +3.2 · +40% ≈ +4.0 · ±2% → 0
 */
export function surpriseToImpact(surprisePct: number): number {
  const a = Math.abs(surprisePct);
  if (a <= 2) return 0;
  const mag = 5 * ((a - 2) / (a - 2 + 10)); // saturating, starts at 0 past the 2% deadzone
  return Math.sign(surprisePct) * mag;
}

/**
 * Turn an earnings report into a scoring catalyst input, with recency decay so a
 * fresh beat counts fully and an old one fades. Returns null when the surprise is
 * unknown, the report is too old/future, or the effect is negligible (in line).
 */
export function earningsCatalystInput(
  r: Pick<EarningsRow, "reportDate" | "surprisePercent" | "fiscalPeriod" | "epsEstimate" | "epsActual">,
  opts: { now?: number; freshnessDays?: number } = {},
): CatalystInput | null {
  if (r.surprisePercent == null) return null;
  const now = opts.now ?? Date.now();
  const freshnessDays = opts.freshnessDays ?? 90;
  const ageDays = (now - Date.parse(r.reportDate)) / 86400000;
  if (!isFinite(ageDays) || ageDays > freshnessDays || ageDays < -3) return null; // stale or future

  const base = surpriseToImpact(r.surprisePercent);
  if (base === 0) return null; // in line — no signal
  // Full weight for ~the first month, fading to 40% by the freshness horizon.
  const decay = Math.max(0.4, Math.min(1, 1 - 0.6 * (Math.max(0, ageDays) / freshnessDays)));
  const impactScore = Math.round(base * decay * 10) / 10;
  if (Math.abs(impactScore) < 0.3) return null;

  const mag = Math.abs(r.surprisePercent);
  const confidence: Confidence = mag >= 10 && ageDays <= 35 ? "high" : mag >= 4 ? "medium" : "low";
  return { impactScore, confidence, status: "occurred", title: describeEarnings(r) };
}

/** Human-readable one-liner for an earnings report. */
export function describeEarnings(
  r: Pick<EarningsRow, "fiscalPeriod" | "surprisePercent" | "epsEstimate" | "epsActual">,
): string {
  const period = r.fiscalPeriod || "Latest quarter";
  const cls = classifySurprise(r.surprisePercent);
  const verb = cls === "beat" ? "beat" : cls === "miss" ? "missed" : "met";
  const pct =
    r.surprisePercent != null
      ? ` (${r.surprisePercent >= 0 ? "+" : ""}${r.surprisePercent.toFixed(1)}%)`
      : "";
  const detail =
    r.epsActual != null && r.epsEstimate != null
      ? `, EPS ${r.epsActual} vs ${r.epsEstimate} est`
      : "";
  return `${period} earnings ${verb} estimates${pct}${detail}`;
}

// --- persistence ------------------------------------------------------------

export interface EarningsInput {
  ticker: string;
  reportDate: string; // ISO date
  fiscalPeriod?: string | null;
  epsEstimate?: number | null;
  epsActual?: number | null;
  revenueEstimate?: number | null;
  revenueActual?: number | null;
  surprisePercent?: number | null; // computed from EPS when omitted
  source?: string;
}

export function addEarningsReport(input: EarningsInput): number {
  const db = getDb();
  const surprise =
    input.surprisePercent ?? computeSurprisePercent(input.epsEstimate, input.epsActual);
  const values = {
    ticker: input.ticker.trim().toUpperCase(),
    fiscalPeriod: input.fiscalPeriod?.trim() || null,
    reportDate: input.reportDate.slice(0, 10),
    epsEstimate: input.epsEstimate ?? null,
    epsActual: input.epsActual ?? null,
    revenueEstimate: input.revenueEstimate ?? null,
    revenueActual: input.revenueActual ?? null,
    surprisePercent: surprise ?? null,
    source: input.source ?? "manual",
    createdAt: nowIso(),
  };
  const row = db
    .insert(schema.earningsReports)
    .values(values)
    .onConflictDoUpdate({
      target: [schema.earningsReports.ticker, schema.earningsReports.reportDate],
      set: values,
    })
    .run();
  return Number(row.lastInsertRowid);
}

export function latestEarningsReport(ticker: string): EarningsRow | undefined {
  return getDb()
    .select()
    .from(schema.earningsReports)
    .where(eq(schema.earningsReports.ticker, ticker.toUpperCase()))
    .orderBy(desc(schema.earningsReports.reportDate))
    .limit(1)
    .get();
}

export function listEarnings(ticker: string, limit = 8): EarningsRow[] {
  return getDb()
    .select()
    .from(schema.earningsReports)
    .where(eq(schema.earningsReports.ticker, ticker.toUpperCase()))
    .orderBy(desc(schema.earningsReports.reportDate))
    .limit(limit)
    .all();
}

export function deleteEarningsReport(id: number): { ok: true } | { error: string } {
  const db = getDb();
  const existing = db
    .select({ id: schema.earningsReports.id })
    .from(schema.earningsReports)
    .where(eq(schema.earningsReports.id, id))
    .get();
  if (!existing) return { error: "earnings report not found" };
  db.delete(schema.earningsReports).where(eq(schema.earningsReports.id, id)).run();
  return { ok: true };
}

export interface FetchEarningsResult {
  tickers: number;
  saved: number;
  errors: string[];
}

/**
 * Auto-fetch recent quarterly earnings (estimate vs actual) for tickers from
 * Yahoo (plain HTTP first, headless browser fallback) and store them. Best
 * effort: a ticker that fails (no data, consent wall, etc.) is recorded as an
 * error, never thrown. Imported lazily so non-fetch paths stay light.
 */
export async function fetchEarningsForTickers(tickers: string[]): Promise<FetchEarningsResult> {
  const { getYahooEarnings } = await import("./yahooHttp");
  const result: FetchEarningsResult = { tickers: tickers.length, saved: 0, errors: [] };
  // Parallel fetch, bounded to stay polite to Yahoo (roadmap #46); the SQLite
  // writes are synchronous on the main thread, so shared counters are safe.
  await mapPool(tickers, EARNINGS_FETCH_CONCURRENCY, async (ticker) => {
    try {
      const rows = await getYahooEarnings(ticker);
      for (const r of rows) {
        addEarningsReport({
          ticker,
          reportDate: r.reportDate,
          fiscalPeriod: r.fiscalPeriod,
          epsEstimate: r.epsEstimate,
          epsActual: r.epsActual,
          source: "yahoo",
        });
        result.saved++;
      }
    } catch (e) {
      result.errors.push(`${ticker}: ${errorMessage(e)}`);
    }
  });
  return result;
}

export interface FetchUpcomingEarningsResult {
  tickers: number;
  inserted: number;
  updated: number;
  errors: string[];
}

/**
 * Refresh each ticker's *upcoming* earnings date from Yahoo's calendarEvents and
 * upsert it as a schedule marker (so the earnings-proximity guard has data — the
 * quarterly fetch above only stores past results). Best effort: a ticker that
 * fails or has no scheduled date is skipped, never thrown. Imported lazily.
 */
export async function fetchUpcomingEarningsForTickers(
  tickers: string[],
): Promise<FetchUpcomingEarningsResult> {
  const { getYahooNextEarningsDate } = await import("./yahooHttp");
  const { upsertUpcomingEarningsCatalyst } = await import("./catalysts");
  const result: FetchUpcomingEarningsResult = {
    tickers: tickers.length,
    inserted: 0,
    updated: 0,
    errors: [],
  };
  await mapPool(tickers, EARNINGS_FETCH_CONCURRENCY, async (ticker) => {
    try {
      const date = await getYahooNextEarningsDate(ticker);
      if (!date) return;
      const outcome = upsertUpcomingEarningsCatalyst(ticker, date);
      if (outcome === "inserted") result.inserted++;
      else if (outcome === "updated") result.updated++;
    } catch (e) {
      result.errors.push(`${ticker}: ${errorMessage(e)}`);
    }
  });
  return result;
}

/**
 * Earnings-surprise nudge from freshly-fetched Yahoo earnings history (for
 * discovery candidates, which aren't in the DB). Picks the most recent report,
 * derives the surprise %, and reuses the same decay/impact mapping as tracked
 * scoring. Returns { impact, reason } for scoreStock, or null when not usable.
 */
export function earningsNudgeFromParsed(
  rows: { reportDate: string; fiscalPeriod?: string; epsEstimate: number | null; epsActual: number | null }[],
  opts: { now?: number; freshnessDays?: number } = {},
): { impact: number; reason: string } | null {
  const latest = [...rows].sort((a, b) => b.reportDate.localeCompare(a.reportDate))[0];
  if (!latest) return null;
  const surprisePercent = computeSurprisePercent(latest.epsEstimate, latest.epsActual);
  const input = earningsCatalystInput(
    {
      reportDate: latest.reportDate,
      surprisePercent,
      fiscalPeriod: latest.fiscalPeriod ?? null,
      epsEstimate: latest.epsEstimate,
      epsActual: latest.epsActual,
    },
    opts,
  );
  return input ? { impact: input.impactScore, reason: input.title ?? "Earnings surprise" } : null;
}

/** The latest report's scoring signal for a ticker (null when none/old/in-line). */
export function earningsSignalForTicker(
  ticker: string,
  opts: { now?: number; freshnessDays?: number } = {},
): CatalystInput | null {
  const latest = latestEarningsReport(ticker);
  return latest ? earningsCatalystInput(latest, opts) : null;
}
