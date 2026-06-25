import { desc, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { loadConfig } from "@/lib/config";
import type { Bar } from "@/lib/types";
import { AlpacaService } from "./alpaca";
import { getYahooService } from "./yahooFinanceBrowser";
import { computeIndicators, type IndicatorSnapshot } from "./indicators";
import { computeDrawdown, type DrawdownReport } from "./buyZone";
import { scoreStock, DEFAULT_STOCK_WEIGHTS, type StockScoreResult, type StockScoreWeights, type CatalystInput } from "./scoring";
import { getCatalystInputs } from "./marketData";
import { getProvider } from "./researchAgent";
import { edgeCatalystsForTicker } from "./catalystEdge";

// Discovery / "scout" agent. Scans a universe of liquid stocks, scores each with
// the same engine used for tracked tickers, and proposes those that pass the
// configured score "test" as agent_candidates (pending the user's accept/decline).
// Accepting a candidate promotes it into the real watchlist.
//
// Scoring here is done in memory from freshly fetched bars — candidate tickers
// are NOT persisted into price_bars/stock_scores until the user accepts one and
// a normal refresh picks it up. This keeps the DB free of declined-ticker noise.

const nowIso = () => new Date().toISOString();

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
}

/**
 * Pure scoring core: turn bars + price into a scored candidate. No IO, so this
 * is unit-testable. `analyzeTicker` wraps it with the network fetches.
 */
export function buildCandidate(input: {
  ticker: string;
  bars: Bar[];
  price: number | null;
  companyName?: string | null;
  catalysts?: CatalystInput[];
  weights?: StockScoreWeights;
}): CandidateAnalysis | null {
  const { ticker, bars } = input;
  if (input.price == null && bars.length === 0) return null;
  const indicators = bars.length > 0 ? computeIndicators(bars) : null;
  const price = input.price ?? indicators?.price ?? null;
  const drawdown = price != null && bars.length > 0 ? computeDrawdown(bars, price) : null;
  const catalysts = input.catalysts ?? [];

  // Untracked names have no catalysts, so the catalyst/sentiment components would
  // sit at their neutral (~5) and structurally cap the blended score below the
  // "Buy Candidate" range. For discovery we score on the components we can
  // actually measure from price — momentum, valuation-by-range, risk —
  // re-normalizing the weights. (combineStockScore divides by the weight sum.)
  const base = input.weights ?? DEFAULT_STOCK_WEIGHTS;
  const weights =
    catalysts.length === 0 ? { ...base, catalyst: 0, sentiment: 0 } : base;

  const score = scoreStock({ indicators, drawdown, catalysts, weights });
  return { ticker, companyName: input.companyName ?? null, price, indicators, drawdown, score };
}

/** Does a candidate clear the score "test"? */
export function passesTest(a: CandidateAnalysis, minScore: number): boolean {
  return a.score.overallScore >= minScore;
}

/** Fetch bars + latest price for one ticker and score it, all in memory. */
async function analyzeTicker(
  ticker: string,
  alpaca: AlpacaService | null,
  cfg = loadConfig(),
): Promise<CandidateAnalysis | null> {
  const bars = alpaca ? await alpaca.getHistoricalBars(ticker, "1Day", 400).catch(() => []) : [];
  let price: number | null = bars.length > 0 ? bars[bars.length - 1].close : null;
  let companyName: string | null = null;

  if (alpaca) {
    const snap = await alpaca.getSnapshot(ticker).catch(() => null);
    if (snap?.latestPrice != null) price = snap.latestPrice;
  }

  // Yahoo fallback for price/company when Alpaca is unavailable.
  if (price == null && cfg.yahooBrowserEnabled) {
    const fields = await getYahooService().getSummaryFields(ticker).catch(() => null);
    if (fields) {
      price = fields.regularPrice;
      companyName = fields.companyName;
    }
  }

  return buildCandidate({
    ticker,
    bars,
    price,
    companyName,
    catalysts: getCatalystInputs(ticker), // usually empty for untracked tickers
    weights: cfg.stockScoreWeights,
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
  parts.push(`Scores ${a.score.overallScore.toFixed(1)}/10 (${a.score.recommendation}).`);
  const mom = a.score.reasoning.momentum?.[0];
  if (mom) parts.push(mom);
  if (a.drawdown?.drawdownFrom52wHighPercent != null) {
    parts.push(
      `Trading ${Math.abs(a.drawdown.drawdownFrom52wHighPercent).toFixed(1)}% below its 52-week high.`,
    );
  }
  const risk = a.score.reasoning.risk?.find((r) => /volatility/i.test(r));
  if (risk) parts.push(risk);
  return parts.join(" ");
}

async function buildRationale(a: CandidateAnalysis): Promise<{ text: string; by: "llm" | "rules" }> {
  const fallback = ruleBasedRationale(a);
  const provider = getProvider();
  if (!provider) return { text: fallback, by: "rules" };
  const prompt = `You are a cautious swing-trading scout. Using ONLY the data below, write ONE concise sentence (max 40 words) explaining why ${a.ticker} may be worth watching. Hedge, never guarantee returns, never give financial advice.

DATA:
Overall score: ${a.score.overallScore}/10 (${a.score.recommendation}, confidence ${a.score.confidence})
Components: ${JSON.stringify(a.score.components)}
Reasoning: ${JSON.stringify(a.score.reasoning)}
Drawdown from 52w high: ${a.drawdown?.drawdownFrom52wHighPercent?.toFixed(1) ?? "n/a"}%

Respond with the sentence only, no preamble.`;
  try {
    const raw = (await provider.complete(prompt, { maxTokens: 120 })).trim();
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

/** Scan the universe and persist new pending candidates that pass the score test. */
export async function runDiscoveryScan(opts: { universe?: string[]; minScore?: number } = {}): Promise<ScanResult> {
  const cfg = loadConfig();
  const minScore = opts.minScore ?? cfg.agentMinScore;
  const alpaca = AlpacaService.fromEnv();
  const excluded = excludedTickers();
  const universe = (opts.universe ?? DEFAULT_UNIVERSE).filter((t) => !excluded.has(t.toUpperCase()));
  const db = getDb();
  const result: ScanResult = { scanned: 0, proposed: 0, candidates: [], errors: [] };

  for (const ticker of universe) {
    try {
      const a = await analyzeTicker(ticker, alpaca, cfg);
      result.scanned++;
      if (!a || !passesTest(a, minScore)) continue;

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
        overallScore: a.score.overallScore,
        valuationScore: a.score.components.valuationScore,
        momentumScore: a.score.components.momentumScore,
        catalystScore: a.score.components.catalystScore,
        riskScore: a.score.components.riskScore,
        sentimentScore: a.score.components.sentimentScore,
        recommendation: a.score.recommendation,
        confidence: a.score.confidence,
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
    } catch (e) {
      result.errors.push(`${ticker}: ${e instanceof Error ? e.message : String(e)}`);
    }
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
  const now = nowIso();
  const values = {
    ticker: c.ticker,
    companyName: c.companyName ?? null,
    targetBuyLow: c.suggestedBuyLow ?? null,
    targetBuyHigh: c.suggestedBuyHigh ?? null,
    notes: `Added from Agent Picks — ${c.rationale ?? "agent-proposed"}`.slice(0, 500),
    updatedAt: now,
  };
  db.insert(schema.watchlistItems)
    .values({ ...values, createdAt: now })
    .onConflictDoUpdate({ target: schema.watchlistItems.ticker, set: values })
    .run();
  db.update(schema.agentCandidates)
    .set({ status: "accepted", decidedAt: now })
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
