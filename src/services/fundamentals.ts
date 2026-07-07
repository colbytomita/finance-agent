import { clamp } from "@/lib/util";
import { fetchQuoteSummary } from "./yahooHttp";
import type { ComponentResult } from "./scoring";

// Company fundamentals for discovery/scoring: growth, profitability, valuation,
// balance sheet, and analyst view, pulled from Yahoo's quoteSummary financial
// modules over plain HTTP. The mapper and the scoring are pure (unit-tested);
// the score is a heuristic read of company quality + value, labelled as such —
// not financial advice or a price prediction.

export interface Fundamentals {
  ticker: string;
  // Growth — trailing YoY fractions (0.10 = +10%).
  revenueGrowth: number | null;
  earningsGrowth: number | null;
  // Profitability — fractions.
  grossMargins: number | null;
  operatingMargins: number | null;
  profitMargins: number | null;
  returnOnEquity: number | null;
  // Valuation.
  trailingPE: number | null;
  forwardPE: number | null;
  pegRatio: number | null;
  priceToBook: number | null;
  // Balance sheet / cash.
  debtToEquity: number | null; // percent-scaled, e.g. 145 = 145%
  freeCashflow: number | null;
  // Analyst.
  recommendationKey: string | null; // strong_buy | buy | hold | underperform | sell | none
  numberOfAnalystOpinions: number | null;
  targetMeanPrice: number | null;
  currentPrice: number | null;
  // Profile.
  sector: string | null;
  industry: string | null;
}

/** The quoteSummary modules the mapper reads. */
export const FUNDAMENTALS_MODULES = "financialData,defaultKeyStatistics,summaryDetail,assetProfile";

type RawNum = { raw?: number } | number | null | undefined;
const num = (v: RawNum): number | null => {
  const n = typeof v === "number" ? v : v?.raw;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() && v.toLowerCase() !== "none" ? v : null;

/** Map a quoteSummary payload (financialData + keyStats + summaryDetail + profile). Pure. */
export function fundamentalsFromQuoteSummary(json: unknown, ticker: string): Fundamentals | null {
  const result = (
    json as {
      quoteSummary?: {
        result?: Array<{
          financialData?: Record<string, RawNum | string>;
          defaultKeyStatistics?: Record<string, RawNum>;
          summaryDetail?: Record<string, RawNum>;
          assetProfile?: Record<string, unknown>;
        }>;
      };
    }
  )?.quoteSummary?.result?.[0];
  if (!result) return null;
  const fd = result.financialData ?? {};
  const ks = result.defaultKeyStatistics ?? {};
  const sd = result.summaryDetail ?? {};
  const ap = result.assetProfile ?? {};

  const f: Fundamentals = {
    ticker: ticker.toUpperCase(),
    revenueGrowth: num(fd.revenueGrowth as RawNum),
    earningsGrowth: num(fd.earningsGrowth as RawNum),
    grossMargins: num(fd.grossMargins as RawNum),
    operatingMargins: num(fd.operatingMargins as RawNum),
    profitMargins: num((fd.profitMargins ?? ks.profitMargins) as RawNum),
    returnOnEquity: num(fd.returnOnEquity as RawNum),
    trailingPE: num(sd.trailingPE as RawNum),
    forwardPE: num((sd.forwardPE ?? ks.forwardPE) as RawNum),
    pegRatio: num(ks.pegRatio as RawNum),
    priceToBook: num(ks.priceToBook as RawNum),
    debtToEquity: num(fd.debtToEquity as RawNum),
    freeCashflow: num(fd.freeCashflow as RawNum),
    recommendationKey: str(fd.recommendationKey),
    numberOfAnalystOpinions: num(fd.numberOfAnalystOpinions as RawNum),
    targetMeanPrice: num(fd.targetMeanPrice as RawNum),
    currentPrice: num(fd.currentPrice as RawNum),
    sector: str(ap.sector),
    industry: str(ap.industry),
  };
  // Require at least one substantive datapoint, else treat as "no data".
  const any =
    f.revenueGrowth != null ||
    f.profitMargins != null ||
    f.forwardPE != null ||
    f.recommendationKey != null;
  return any ? f : null;
}

/**
 * Fetch + map fundamentals for a ticker. HTTP-only, best effort. Retries once
 * on an empty result — under concurrent scans Yahoo occasionally rate-limits a
 * request, and a transient null must not quietly demote a name to a
 * momentum-only read in the fundamentals-led scorer.
 */
export async function getYahooFundamentals(ticker: string): Promise<Fundamentals | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const json = await fetchQuoteSummary(ticker, FUNDAMENTALS_MODULES);
    const f = json ? fundamentalsFromQuoteSummary(json, ticker) : null;
    if (f) return f;
    if (attempt === 0) await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

const pct = (v: number | null): string => (v == null ? "n/a" : `${(v * 100).toFixed(0)}%`);

// --- Sub-scores (each 1–10, higher = better). Pure. --------------------------

function growthSubscore(f: Fundamentals): { score: number; reason: string } | null {
  const rg = f.revenueGrowth;
  const eg = f.earningsGrowth;
  if (rg == null && eg == null) return null;
  let s = 5;
  if (rg != null) {
    if (rg >= 0.2) s += 2.2;
    else if (rg >= 0.1) s += 1.4;
    else if (rg >= 0.04) s += 0.7;
    else if (rg >= 0) s += 0.1;
    else if (rg >= -0.1) s -= 1.5;
    else s -= 2.6;
  }
  if (eg != null) {
    if (eg >= 0.25) s += 1.6;
    else if (eg >= 0.1) s += 1;
    else if (eg >= 0) s += 0.3;
    else if (eg >= -0.2) s -= 1.3;
    else s -= 2.2;
  }
  return { score: clamp(s, 1, 10), reason: `Revenue ${pct(rg)} YoY, earnings ${pct(eg)} YoY.` };
}

function profitabilitySubscore(f: Fundamentals): { score: number; reason: string } | null {
  const { profitMargins: pm, returnOnEquity: roe, grossMargins: gm } = f;
  if (pm == null && roe == null && gm == null) return null;
  let s = 5;
  if (pm != null) {
    if (pm >= 0.2) s += 2;
    else if (pm >= 0.1) s += 1.2;
    else if (pm >= 0.03) s += 0.4;
    else if (pm > 0) s -= 0.3;
    else s -= 2.2; // unprofitable
  }
  if (roe != null) {
    if (roe >= 0.2) s += 1.5;
    else if (roe >= 0.1) s += 0.8;
    else if (roe >= 0) s += 0.1;
    else s -= 1.2;
  }
  if (gm != null && gm >= 0.5) s += 0.5;
  return { score: clamp(s, 1, 10), reason: `Net margin ${pct(pm)}, ROE ${pct(roe)}.` };
}

function valuationSubscore(f: Fundamentals): { score: number; reason: string } | null {
  const { pegRatio: peg, forwardPE: fpe, priceToBook: pb } = f;
  if (peg == null && fpe == null && pb == null) return null;
  let s = 5;
  if (peg != null && peg > 0) {
    if (peg <= 1) s += 2;
    else if (peg <= 1.5) s += 1;
    else if (peg <= 2) s += 0;
    else if (peg <= 3) s -= 1;
    else s -= 2;
  }
  if (fpe != null) {
    if (fpe <= 0) s -= 0.8; // no forward earnings
    else if (fpe <= 15) s += 1;
    else if (fpe <= 25) s += 0.3;
    else if (fpe <= 40) s -= 0.6;
    else s -= 1.6;
  }
  if (pb != null && pb > 0 && pb <= 1.5) s += 0.4;
  const pegTxt = peg != null ? peg.toFixed(1) : "n/a";
  const feTxt = fpe != null ? fpe.toFixed(0) : "n/a";
  return { score: clamp(s, 1, 10), reason: `Forward P/E ${feTxt}, PEG ${pegTxt}.` };
}

const REC_ADJ: Record<string, number> = {
  strong_buy: 2.5,
  buy: 1.5,
  hold: 0,
  underperform: -1.5,
  sell: -2.5,
};

function analystSubscore(f: Fundamentals): { score: number; reason: string } | null {
  const rec = f.recommendationKey;
  const upside =
    f.targetMeanPrice != null && f.currentPrice != null && f.currentPrice > 0
      ? (f.targetMeanPrice - f.currentPrice) / f.currentPrice
      : null;
  if (rec == null && upside == null) return null;
  let s = 5;
  if (rec != null) s += REC_ADJ[rec] ?? 0;
  if (upside != null) {
    if (upside >= 0.2) s += 1.5;
    else if (upside >= 0.05) s += 0.6;
    else if (upside <= -0.05) s -= 1;
  }
  // Dampen toward neutral when very few analysts cover the name.
  const n = f.numberOfAnalystOpinions ?? 0;
  if (n > 0 && n < 4) s = 5 + (s - 5) * 0.6;
  const recTxt = rec ? rec.replace(/_/g, " ") : "n/a";
  const upTxt = upside != null ? `${upside >= 0 ? "+" : ""}${(upside * 100).toFixed(0)}% to mean target` : "no target";
  return { score: clamp(s, 1, 10), reason: `Analyst consensus: ${recTxt}, ${upTxt}.` };
}

const SUB_WEIGHTS = { growth: 0.3, profitability: 0.25, valuation: 0.25, analyst: 0.2 };

/**
 * Blend the fundamental sub-scores into a 1–10 quality/value read. Weights are
 * renormalized over whichever dimensions have data, so a name with partial
 * coverage still scores on what's known. Returns a neutral 5 with an explicit
 * "no data" reason when nothing is available (so it never fabricates a signal).
 */
export function fundamentalsScore(f: Fundamentals | null): ComponentResult {
  if (!f) return { score: 5, reasons: ["No fundamental data available — neutral."] };
  const subs = [
    { key: "growth" as const, r: growthSubscore(f) },
    { key: "profitability" as const, r: profitabilitySubscore(f) },
    { key: "valuation" as const, r: valuationSubscore(f) },
    { key: "analyst" as const, r: analystSubscore(f) },
  ].filter((x): x is { key: keyof typeof SUB_WEIGHTS; r: { score: number; reason: string } } => x.r != null);

  if (subs.length === 0) return { score: 5, reasons: ["No fundamental data available — neutral."] };

  let weighted = 0;
  let weightSum = 0;
  for (const s of subs) {
    const w = SUB_WEIGHTS[s.key];
    weighted += s.r.score * w;
    weightSum += w;
  }
  const score = Math.round((weighted / weightSum) * 10) / 10;
  return { score: clamp(score, 1, 10), reasons: subs.map((s) => s.r.reason) };
}

/** Compact one-line fact string for LLM prompts and rule-based rationales. */
export function fundamentalsSummary(f: Fundamentals | null): string {
  if (!f) return "No fundamental data available.";
  const parts: string[] = [];
  if (f.revenueGrowth != null) parts.push(`revenue ${pct(f.revenueGrowth)} YoY`);
  if (f.earningsGrowth != null) parts.push(`earnings ${pct(f.earningsGrowth)} YoY`);
  if (f.profitMargins != null) parts.push(`net margin ${pct(f.profitMargins)}`);
  if (f.returnOnEquity != null) parts.push(`ROE ${pct(f.returnOnEquity)}`);
  if (f.forwardPE != null) parts.push(`fwd P/E ${f.forwardPE.toFixed(0)}`);
  if (f.pegRatio != null) parts.push(`PEG ${f.pegRatio.toFixed(1)}`);
  if (f.recommendationKey) {
    const upside =
      f.targetMeanPrice != null && f.currentPrice != null && f.currentPrice > 0
        ? ` (${((f.targetMeanPrice - f.currentPrice) / f.currentPrice) * 100 >= 0 ? "+" : ""}${(
            ((f.targetMeanPrice - f.currentPrice) / f.currentPrice) *
            100
          ).toFixed(0)}% to target)`
        : "";
    parts.push(`analysts ${f.recommendationKey.replace(/_/g, " ")}${upside}`);
  }
  if (f.sector) parts.push(f.sector);
  return parts.length > 0 ? parts.join(", ") + "." : "No fundamental data available.";
}
