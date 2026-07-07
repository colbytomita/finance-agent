import { desc, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { loadConfig } from "@/lib/config";
import type { Bar } from "@/lib/types";
import { AlpacaService } from "./alpaca";
import { getYahooDailyBars, getYahooSummaryFields } from "./yahooHttp";
import { computeIndicators, type IndicatorSnapshot } from "./indicators";
import { computeDrawdown, type DrawdownReport } from "./buyZone";
import { scoreStock, scoreRowValues, DEFAULT_STOCK_WEIGHTS, type StockScoreResult, type StockScoreWeights, type CatalystInput } from "./scoring";
import { upsertWatchlistItem } from "./watchlist";
import { getCatalystInputs } from "./marketData";
import { getProvider } from "./llm";
import { edgeCatalystsForTicker } from "./catalystEdge";
import {
  fundamentalsScore,
  fundamentalsSummary,
  getYahooFundamentals,
  type Fundamentals,
} from "./fundamentals";
import { earningsNudgeFromParsed } from "./earnings";
import { getYahooEarnings } from "./yahooHttp";
import { errorMessage, mapPool, nowIso } from "@/lib/util";

// Discovery / "scout" agent. Scans a universe of liquid stocks, scores each with
// the same engine used for tracked tickers, and proposes those that pass the
// configured score "test" as agent_candidates (pending the user's accept/decline).
// Accepting a candidate promotes it into the real watchlist.
//
// Scoring here is done in memory from freshly fetched bars — candidate tickers
// are NOT persisted into price_bars/stock_scores until the user accepts one and
// a normal refresh picks it up. This keeps the DB free of declined-ticker noise.

/**
 * Default candidate universe: liquid US large/mid-caps across sectors. This is a
 * starting point, not a recommendation — the agent only proposes names from here
 * that pass the score test, and you still accept/decline each one.
 */
export const DEFAULT_UNIVERSE: string[] = [
  // Mega-cap tech / communication
  "AAPL", "MSFT", "GOOGL", "AMZN", "META", "NVDA", "AVGO", "ORCL", "ADBE", "CRM",
  "NFLX", "AMD", "INTC", "QCOM", "TXN", "MU", "CSCO", "IBM", "NOW", "INTU",
  // Consumer
  "TSLA", "HD", "NKE", "MCD", "SBUX", "COST", "WMT", "TGT", "LOW", "DIS",
  // Financials
  "JPM", "BAC", "GS", "MS", "V", "MA", "AXP", "SCHW", "BLK", "C",
  // Health care
  "UNH", "JNJ", "LLY", "ABBV", "MRK", "PFE", "TMO", "ABT", "DHR", "AMGN",
  // Industrials / energy / materials
  "CAT", "DE", "BA", "GE", "HON", "UPS", "XOM", "CVX", "COP", "FCX",
  // Semis / growth extras
  "ASML", "ARM", "SMCI", "PLTR", "SHOP", "UBER", "ABNB", "PANW", "SNOW", "DDOG",
];

export interface CandidateAnalysis {
  ticker: string;
  companyName: string | null;
  price: number | null;
  indicators: IndicatorSnapshot | null;
  drawdown: DrawdownReport | null;
  score: StockScoreResult;
  /** Company fundamentals read (null when unavailable). */
  fundamentals: Fundamentals | null;
  fundamentalsScore: number | null;
}

/**
 * Pure scoring core: turn bars + price (+ optional fundamentals/earnings) into a
 * scored candidate. No IO, so this is unit-testable. `analyzeTicker` wraps it
 * with the network fetches.
 */
export function buildCandidate(input: {
  ticker: string;
  bars: Bar[];
  price: number | null;
  companyName?: string | null;
  catalysts?: CatalystInput[];
  weights?: StockScoreWeights;
  fundamentals?: Fundamentals | null;
  earnings?: { impact: number; reason: string } | null;
}): CandidateAnalysis | null {
  const { ticker, bars } = input;
  if (input.price == null && bars.length === 0) return null;
  const indicators = bars.length > 0 ? computeIndicators(bars) : null;
  const price = input.price ?? indicators?.price ?? null;
  const drawdown = price != null && bars.length > 0 ? computeDrawdown(bars, price) : null;
  const catalysts = input.catalysts ?? [];

  // Untracked names have no catalysts, so the catalyst/sentiment components sit at
  // their neutral (~5); scoreStock drops them from the technical blend. The
  // overall score is led by fundamentals (company quality/value) when available,
  // with the technical blend (momentum, valuation-by-range, risk) as a
  // supporting/timing signal, plus the earnings-surprise nudge.
  const base = input.weights ?? DEFAULT_STOCK_WEIGHTS;
  const weights =
    catalysts.length === 0 ? { ...base, catalyst: 0, sentiment: 0 } : base;
  const fund = input.fundamentals ? fundamentalsScore(input.fundamentals) : null;

  const score = scoreStock({
    indicators,
    drawdown,
    catalysts,
    weights,
    earnings: input.earnings ?? null,
    fundamentals: fund,
  });
  return {
    ticker,
    companyName: input.companyName ?? null,
    price,
    indicators,
    drawdown,
    score,
    fundamentals: input.fundamentals ?? null,
    fundamentalsScore: fund?.score ?? null,
  };
}

/** Does a candidate clear the score "test"? */
export function passesTest(a: CandidateAnalysis, minScore: number): boolean {
  return a.score.overallScore >= minScore;
}

/** Fetch bars + latest price for one ticker and score it, all in memory. */
export async function analyzeTicker(
  ticker: string,
  alpaca: AlpacaService | null,
  cfg = loadConfig(),
): Promise<CandidateAnalysis | null> {
  // Bars: Alpaca when configured, otherwise Yahoo's crumb-free chart endpoint —
  // so discovery/Sector Scout can still score real data without Alpaca keys.
  let bars = alpaca ? await alpaca.getHistoricalBars(ticker, "1Day", 400).catch(() => []) : [];
  if (bars.length === 0) bars = await getYahooDailyBars(ticker, 400).catch(() => []);
  let price: number | null = bars.length > 0 ? bars[bars.length - 1].close : null;
  let companyName: string | null = null;

  if (alpaca) {
    const snap = await alpaca.getSnapshot(ticker).catch(() => null);
    if (snap?.latestPrice != null) price = snap.latestPrice;
  }

  // Yahoo fallback for price/company when Alpaca is unavailable.
  if (price == null && cfg.yahooEnabled) {
    const fields = await getYahooSummaryFields(ticker).catch(() => null);
    if (fields) {
      price = fields.regularPrice;
      companyName = fields.companyName;
    }
  }

  // Fundamentals + latest earnings surprise drive the fundamentals-led score.
  // Both are Yahoo HTTP calls, best effort — a failure just degrades to the
  // technical read for that name (and respects the Yahoo connector toggle).
  let fundamentals: Fundamentals | null = null;
  let earnings: { impact: number; reason: string } | null = null;
  if (cfg.yahooEnabled) {
    fundamentals = await getYahooFundamentals(ticker).catch(() => null);
    const earn = await getYahooEarnings(ticker).catch(() => []);
    earnings = earningsNudgeFromParsed(earn, { freshnessDays: cfg.catalystFreshnessDays });
  }

  return buildCandidate({
    ticker,
    bars,
    price,
    companyName,
    catalysts: getCatalystInputs(ticker), // usually empty for untracked tickers
    weights: cfg.stockScoreWeights,
    fundamentals,
    earnings,
  });
}

/** Derive a suggested buy zone (low/high) from technicals. */
export function suggestBuyZone(a: CandidateAnalysis): { low: number | null; high: number | null } {
  const price = a.price;
  if (price == null) return { low: null, high: null };
  const ind = a.indicators;
  const supportCandidates = [ind?.support, ind?.thirtyDayLow, ind?.sma50].filter(
    (v): v is number => v != null && v > 0 && v < price,
  );
  const low = supportCandidates.length > 0 ? Math.max(...supportCandidates) : price * 0.93;
  // Upper edge: current price, but never below the low.
  const high = Math.max(low, price);
  const round = (v: number) => Math.round(v * 100) / 100;
  return { low: round(low), high: round(high) };
}

function ruleBasedRationale(a: CandidateAnalysis): string {
  const parts: string[] = [];
  if (a.fundamentalsScore != null) {
    parts.push(`Fundamentals ${a.fundamentalsScore.toFixed(1)}/10: ${fundamentalsSummary(a.fundamentals)}`);
  }
  const earn = a.score.reasoning.earnings?.[0];
  if (earn) parts.push(earn);
  const mom = a.score.reasoning.momentum?.[0];
  if (mom) parts.push(`Chart: ${mom}`);
  if (a.drawdown?.drawdownFrom52wHighPercent != null) {
    parts.push(
      `Trading ${Math.abs(a.drawdown.drawdownFrom52wHighPercent).toFixed(1)}% below its 52-week high.`,
    );
  }
  parts.push(`Overall ${a.score.overallScore.toFixed(1)}/10 (${a.score.recommendation}).`);
  return parts.join(" ");
}

async function buildRationale(a: CandidateAnalysis): Promise<{ text: string; by: "llm" | "rules" }> {
  const fallback = ruleBasedRationale(a);
  const provider = getProvider();
  if (!provider) return { text: fallback, by: "rules" };
  // A grounded, research-style verdict — fundamentals-first, like a cautious
  // analyst read, using ONLY the fetched data.
  const upside =
    a.fundamentals?.targetMeanPrice != null && a.price != null && a.price > 0
      ? `${(((a.fundamentals.targetMeanPrice - a.price) / a.price) * 100).toFixed(0)}%`
      : "n/a";
  const prompt = `You are a cautious equity research analyst screening a stock as a potential swing-trade buy. Using ONLY the data below, write a 2-sentence verdict: sentence 1 gives a verdict label (e.g. "Buy candidate", "Accumulate on pullbacks", "Wait", "Pass") and the core fundamental reason; sentence 2 names the main risk or what would confirm the thesis. Be specific with the numbers. Hedge, never guarantee returns, never give financial advice.

TICKER: ${a.ticker}${a.companyName ? ` (${a.companyName})` : ""}
FUNDAMENTALS (${a.fundamentalsScore?.toFixed(1) ?? "n/a"}/10): ${fundamentalsSummary(a.fundamentals)}
SECTOR/INDUSTRY: ${a.fundamentals?.sector ?? "n/a"}${a.fundamentals?.industry ? ` / ${a.fundamentals.industry}` : ""}
EARNINGS: ${a.score.reasoning.earnings?.[0] ?? "no recent surprise data"}
ANALYST TARGET UPSIDE: ${upside}
CHART: ${a.score.reasoning.momentum?.join(" ") ?? "n/a"}; drawdown from 52w high ${a.drawdown?.drawdownFrom52wHighPercent?.toFixed(1) ?? "n/a"}%
RISK: ${a.score.reasoning.risk?.join(" ") ?? "n/a"}
OVERALL SCORE: ${a.score.overallScore}/10 (${a.score.recommendation}, fundamentals-led)

Respond with the two sentences only, no preamble.`;
  try {
    const raw = (await provider.complete(prompt, { maxTokens: 200 })).trim();
    return { text: raw.replace(/^["']|["']$/g, "") || fallback, by: "llm" };
  } catch {
    return { text: fallback, by: "rules" };
  }
}

/** Tickers already tracked or already decided — never propose these. */
function excludedTickers(): Set<string> {
  const db = getDb();
  const s = new Set<string>();
  for (const r of db.select({ t: schema.watchlistItems.ticker }).from(schema.watchlistItems).all()) s.add(r.t);
  for (const r of db.select({ t: schema.portfolioHoldings.ticker }).from(schema.portfolioHoldings).all()) s.add(r.t);
  for (const r of db
    .select({ t: schema.activeTrades.ticker })
    .from(schema.activeTrades)
    .where(eq(schema.activeTrades.status, "open"))
    .all())
    s.add(r.t);
  // Already accepted or declined candidates stay decided until the user clears them.
  for (const r of db
    .select({ t: schema.agentCandidates.ticker, st: schema.agentCandidates.status })
    .from(schema.agentCandidates)
    .where(inArray(schema.agentCandidates.status, ["accepted", "declined"]))
    .all())
    s.add(r.t);
  return s;
}

export interface ScanResult {
  scanned: number;
  proposed: number;
  candidates: { ticker: string; score: number }[];
  errors: string[];
}

/** Bounded concurrency for the scan's per-ticker network fetches (bars + fundamentals + earnings). */
const DISCOVERY_CONCURRENCY = 5;

/** Scan the universe and persist new pending candidates that pass the score test. */
export async function runDiscoveryScan(opts: { universe?: string[]; minScore?: number } = {}): Promise<ScanResult> {
  const cfg = loadConfig();
  const minScore = opts.minScore ?? cfg.agentMinScore;
  const alpaca = AlpacaService.fromEnv();
  const excluded = excludedTickers();
  const universe = (opts.universe ?? DEFAULT_UNIVERSE).filter((t) => !excluded.has(t.toUpperCase()));
  const db = getDb();
  const result: ScanResult = { scanned: 0, proposed: 0, candidates: [], errors: [] };

  // Analyze in parallel — each ticker is several network fetches (bars,
  // fundamentals, earnings), so bounded concurrency keeps a ~60-name scan quick.
  const analyzed = await mapPool(universe, DISCOVERY_CONCURRENCY, async (ticker) => {
    try {
      return { ticker, a: await analyzeTicker(ticker, alpaca, cfg), error: null as string | null };
    } catch (e) {
      return { ticker, a: null as CandidateAnalysis | null, error: errorMessage(e) };
    }
  });

  const proposedTickers = new Set<string>();
  // Persist passers sequentially: the LLM verdict is only run for names that
  // clear the bar (few), keeping the research call off the full universe.
  for (const { ticker, a, error } of analyzed) {
    if (error) {
      result.errors.push(`${ticker}: ${error}`);
      continue;
    }
    result.scanned++;
    if (!a) continue;
    // Fundamentals-led contract: never propose a name we couldn't actually
    // research. Without a fundamentals read the score is a momentum-only read,
    // which is exactly what this scan is meant to move past — skip it.
    if (a.fundamentalsScore == null) continue;
    if (!passesTest(a, minScore)) continue;
    proposedTickers.add(a.ticker);

    const { low, high } = suggestBuyZone(a);
    const rationale = await buildRationale(a);
    // Surface any entity catalyst edge for this ticker in the rationale.
    const edges = edgeCatalystsForTicker(a.ticker);
    let rationaleText = rationale.text;
    if (edges.length > 0) {
      const top = [...edges].sort((x, y) => Math.abs(y.impactScore) - Math.abs(x.impactScore))[0];
      rationaleText += ` Entity edge: ${top.title} (impact ${top.impactScore > 0 ? "+" : ""}${top.impactScore}).`;
    }
    const now = nowIso();
    const values = {
      ticker: a.ticker,
      companyName: a.companyName,
      price: a.price,
      ...scoreRowValues(a.score),
      fundamentalsScore: a.fundamentalsScore,
      drawdownPercent: a.drawdown?.drawdownFrom52wHighPercent ?? null,
      suggestedBuyLow: low,
      suggestedBuyHigh: high,
      rationale: rationaleText,
      generatedBy: rationale.by,
      status: "pending" as const,
      proposedAt: now,
      decidedAt: null,
    };
    // Upsert: refresh an existing *pending* row, insert if new. Decided rows are
    // excluded above, so onConflict only ever updates a stale pending row.
    db.insert(schema.agentCandidates)
      .values(values)
      .onConflictDoUpdate({ target: schema.agentCandidates.ticker, set: values })
      .run();
    result.proposed++;
    result.candidates.push({ ticker: a.ticker, score: a.score.overallScore });
  }

  // Prune stale pending picks: a name that was scanned this run but no longer
  // qualifies (dropped below the bar, or lost fundamentals) shouldn't linger as
  // a suggestion. Only touches pending rows for tickers we actually re-scanned;
  // accepted/declined rows are untouched.
  const universeSet = new Set(universe.map((t) => t.toUpperCase()));
  const stale = db
    .select({ id: schema.agentCandidates.id, ticker: schema.agentCandidates.ticker })
    .from(schema.agentCandidates)
    .where(eq(schema.agentCandidates.status, "pending"))
    .all()
    .filter((r) => universeSet.has(r.ticker) && !proposedTickers.has(r.ticker));
  for (const r of stale) {
    db.delete(schema.agentCandidates).where(eq(schema.agentCandidates.id, r.id)).run();
  }

  result.candidates.sort((x, y) => y.score - x.score);
  return result;
}

export function listCandidates(status?: "pending" | "accepted" | "declined") {
  const db = getDb();
  const q = db.select().from(schema.agentCandidates);
  const rows = status
    ? q.where(eq(schema.agentCandidates.status, status)).all()
    : q.all();
  return rows.sort((a, b) => b.overallScore - a.overallScore);
}

/** Promote a candidate into the real watchlist and mark it accepted. */
export function acceptCandidate(id: number): { ok: true; ticker: string } | { error: string } {
  const db = getDb();
  const c = db.select().from(schema.agentCandidates).where(eq(schema.agentCandidates.id, id)).get();
  if (!c) return { error: "candidate not found" };
  upsertWatchlistItem({
    ticker: c.ticker,
    companyName: c.companyName,
    targetBuyLow: c.suggestedBuyLow,
    targetBuyHigh: c.suggestedBuyHigh,
    notes: `Added from Agent Picks — ${c.rationale ?? "agent-proposed"}`,
  });
  db.update(schema.agentCandidates)
    .set({ status: "accepted", decidedAt: nowIso() })
    .where(eq(schema.agentCandidates.id, id))
    .run();
  return { ok: true, ticker: c.ticker };
}

export function declineCandidate(id: number): { ok: true } | { error: string } {
  const db = getDb();
  const c = db.select().from(schema.agentCandidates).where(eq(schema.agentCandidates.id, id)).get();
  if (!c) return { error: "candidate not found" };
  db.update(schema.agentCandidates)
    .set({ status: "declined", decidedAt: nowIso() })
    .where(eq(schema.agentCandidates.id, id))
    .run();
  return { ok: true };
}

/** Latest proposal time across pending candidates (for "last scan" display). */
export function lastScanAt(): string | null {
  const db = getDb();
  const row = db
    .select({ at: schema.agentCandidates.proposedAt })
    .from(schema.agentCandidates)
    .orderBy(desc(schema.agentCandidates.proposedAt))
    .limit(1)
    .get();
  return row?.at ?? null;
}
