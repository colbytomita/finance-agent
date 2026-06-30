import { and, desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { loadConfig, type AppConfig } from "@/lib/config";
import { AlpacaService } from "./alpaca";
import {
  analyzeTicker,
  passesTest,
  suggestBuyZone,
  type CandidateAnalysis,
} from "./discoveryAgent";
import { getProvider } from "./researchAgent";
import { edgeCatalystsForTicker } from "./catalystEdge";
import {
  generateCompanyThesisReport,
  type CompanyThesisReport,
} from "./companyThesisScout";

// Sector Scout: on-demand, industry-targeted discovery.
//
// Flow: user types an industry/theme ("space", "energy", "nuclear fusion") ->
// we EXPAND it into candidate tickers (LLM when a key is configured, a curated
// theme map otherwise) -> VALIDATE each by fetching real bars/price (anything
// without real data is dropped, never guessed) -> SCORE it with the same engine
// used everywhere else -> for the ones that clear the score test, generate a
// full bull/bear/risk research brief. Nothing is fabricated and nothing touches
// the watchlist until the user clicks "Add".

const nowIso = () => new Date().toISOString();

/** Normalize a typed industry into a stable, lower-cased storage/display label. */
export function normalizeIndustryLabel(industry: string): string {
  return industry.trim().replace(/\s+/g, " ").toLowerCase();
}

// ----------------------------------------------------------------------------
// Industry -> tickers expansion
// ----------------------------------------------------------------------------

/**
 * Curated theme -> tickers map, used as the offline fallback when no LLM key is
 * configured (or the LLM returns nothing usable). Starting points across sectors,
 * not recommendations — every name is still validated against real price data
 * and scored before it can surface. Tickers that no longer trade just drop out.
 */
const CURATED_THEMES: { keys: string[]; tickers: string[] }[] = [
  { keys: ["energy", "oil", "gas", "oil and gas", "petroleum"], tickers: ["XOM", "CVX", "COP", "SLB", "EOG", "OXY", "PSX", "MPC", "VLO", "WMB", "KMI", "HAL", "DVN", "HES"] },
  { keys: ["space", "aerospace", "rockets", "satellite", "satellites"], tickers: ["RKLB", "ASTS", "LUNR", "RTX", "LMT", "NOC", "BA", "GE", "HEI", "LHX", "RDW", "PL"] },
  { keys: ["ai", "artificial intelligence", "machine learning"], tickers: ["NVDA", "AMD", "PLTR", "MSFT", "GOOGL", "META", "SMCI", "AVGO", "TSM", "ARM", "SNOW"] },
  { keys: ["semiconductor", "semiconductors", "chips", "chip"], tickers: ["NVDA", "AMD", "INTC", "AVGO", "QCOM", "TXN", "MU", "ASML", "TSM", "ARM", "AMAT", "LRCX", "KLAC", "MRVL"] },
  { keys: ["biotech", "biotechnology", "pharma", "pharmaceutical", "healthcare", "health care"], tickers: ["LLY", "ABBV", "MRK", "PFE", "AMGN", "GILD", "VRTX", "REGN", "MRNA", "BIIB", "BNTX"] },
  { keys: ["cybersecurity", "cyber", "security software"], tickers: ["PANW", "CRWD", "ZS", "FTNT", "S", "OKTA", "NET", "CYBR"] },
  { keys: ["ev", "electric vehicle", "electric vehicles", "automaker", "autos"], tickers: ["TSLA", "RIVN", "LCID", "NIO", "GM", "F", "CHPT"] },
  { keys: ["solar", "renewable", "renewables", "clean energy", "green energy"], tickers: ["ENPH", "SEDG", "FSLR", "RUN", "NEE", "BE", "PLUG"] },
  { keys: ["nuclear", "uranium", "fission", "fusion"], tickers: ["CCJ", "LEU", "SMR", "BWXT", "NNE", "UEC", "OKLO"] },
  { keys: ["defense", "defence", "military", "weapons"], tickers: ["LMT", "RTX", "NOC", "GD", "BA", "LHX", "HII", "LDOS"] },
  { keys: ["fintech", "payments", "financial technology"], tickers: ["V", "MA", "PYPL", "COIN", "SOFI", "AXP", "FIS", "HOOD"] },
  { keys: ["cloud", "saas", "software"], tickers: ["MSFT", "CRM", "NOW", "SNOW", "DDOG", "NET", "ORCL", "ADBE", "WDAY"] },
  { keys: ["quantum", "quantum computing"], tickers: ["IONQ", "RGTI", "QBTS", "IBM"] },
  { keys: ["crypto", "cryptocurrency", "blockchain", "bitcoin"], tickers: ["COIN", "MARA", "RIOT", "MSTR", "HOOD", "CLSK"] },
  { keys: ["gold", "mining", "metals", "miners"], tickers: ["NEM", "GOLD", "FCX", "AEM", "SCCO", "WPM"] },
  { keys: ["retail", "consumer", "restaurants"], tickers: ["WMT", "COST", "TGT", "HD", "LOW", "NKE", "MCD", "SBUX"] },
  { keys: ["bank", "banks", "financials", "financial"], tickers: ["JPM", "BAC", "GS", "MS", "WFC", "C", "SCHW", "BLK"] },
];

const TICKER_STOPWORDS = new Set([
  "ETF", "ETFS", "INC", "THE", "AND", "USD", "CEO", "IPO", "JSON", "NULL", "NA", "US", "USA", "API",
]);

/**
 * Parse a free-form / LLM ticker list into clean, plausible symbols. Accepts a
 * JSON array or any delimited text; uppercases, validates symbol shape, drops
 * obvious non-tickers, and de-duplicates while preserving order. Pure — no IO.
 */
export function parseTickerList(raw: string): string[] {
  let tokens: string[] = [];
  let fromJson = false;
  const arrayMatch = raw.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      const parsed = JSON.parse(arrayMatch[0]);
      if (Array.isArray(parsed)) {
        tokens = parsed.map((v) => String(v));
        fromJson = true;
      }
    } catch {
      // fall through to delimiter split
    }
  }
  if (!fromJson) tokens = raw.split(/[^A-Za-z.]+/);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    const trimmed = t.trim();
    if (!trimmed) continue;
    // In the prose-fallback path, only accept tokens already uppercase in the
    // source — real tickers are uppercase, so this avoids harvesting ordinary
    // lowercase words. The JSON-array path trusts the model's list as given.
    if (!fromJson && trimmed !== trimmed.toUpperCase()) continue;
    const sym = trimmed.toUpperCase().replace(/\.$/, "");
    if (!/^[A-Z][A-Z.]{0,5}$/.test(sym)) continue; // 1-6 chars, starts with a letter
    if (TICKER_STOPWORDS.has(sym)) continue;
    if (seen.has(sym)) continue;
    seen.add(sym);
    out.push(sym);
  }
  return out;
}

/** Curated fallback: tickers for an industry by keyword match against the map. */
export function curatedTickersFor(industry: string): string[] {
  const q = normalizeIndustryLabel(industry);
  if (!q) return [];
  const out = new Set<string>();
  for (const theme of CURATED_THEMES) {
    const hit = theme.keys.some((k) => q === k || q.includes(k) || k.includes(q));
    if (hit) theme.tickers.forEach((t) => out.add(t));
  }
  return [...out];
}

export interface IndustryExpansion {
  tickers: string[];
  by: "llm" | "rules";
}

/**
 * Expand an industry/theme into candidate tickers. Uses the configured LLM when
 * available, falling back to the curated theme map (and unioning the curated set
 * in when the LLM result is thin) so a known sector never comes back empty.
 */
export async function expandIndustry(
  industry: string,
  opts: { max?: number } = {},
): Promise<IndustryExpansion> {
  const max = opts.max ?? 24;
  const curated = curatedTickersFor(industry);
  const provider = getProvider();
  if (!provider) {
    return { tickers: curated.slice(0, max), by: "rules" };
  }

  const prompt = `You are a financial research assistant. List up to ${max} publicly traded, US-exchange-listed stocks that are PURE-PLAY or primary-business bets on this industry/theme: "${industry}".

Selection rules:
- Prioritize companies whose CORE business IS this theme (pure-plays and dedicated operators).
- Only include a large diversified company if this theme is a MAJOR, clearly material part of its business. EXCLUDE mega-caps that merely have incidental, minor, or one-division exposure (do not list a broad megacap just because it touches the theme).
- Order the list from most pure-play to least.
- Use real, current ticker symbols in uppercase. Do NOT include ETFs, mutual funds, indices, private companies, or delisted symbols.

Respond with ONLY a JSON array of ticker strings, e.g. ["AAA","BBB"]. No commentary.`;

  try {
    const out = await provider.complete(prompt, { maxTokens: 400 });
    const llm = parseTickerList(out);
    if (llm.length === 0) return { tickers: curated.slice(0, max), by: "rules" };
    // Union with curated to fill gaps, LLM first, capped.
    const merged: string[] = [];
    const seen = new Set<string>();
    for (const t of [...llm, ...curated]) {
      if (seen.has(t)) continue;
      seen.add(t);
      merged.push(t);
      if (merged.length >= max) break;
    }
    return { tickers: merged, by: "llm" };
  } catch {
    return { tickers: curated.slice(0, max), by: "rules" };
  }
}

// ----------------------------------------------------------------------------
// Per-pick research brief (from the in-memory analysis, not the DB)
// ----------------------------------------------------------------------------

export interface SectorBrief {
  summary: string;
  bullCase: string;
  bearCase: string;
  keyCatalysts: string[];
  keyRisks: string[];
  recommendedAction: string;
  confidence: string;
  by: "llm" | "rules";
}

/** Only the per-component reason arrays of a score's reasoning (skip weightsUsed). */
function reasonArrays(a: CandidateAnalysis): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(a.score.reasoning ?? {})) {
    if (Array.isArray(v)) out[k] = v as string[];
  }
  return out;
}

/** A minimal entity-edge shape — just what the brief needs. */
export interface BriefEdge {
  title: string;
  impactScore: number;
}

/**
 * Rule-based brief built purely from the in-memory candidate analysis. Pure (no
 * IO): the caller passes any entity-edge catalysts so this stays unit-testable.
 */
export function ruleBriefFromAnalysis(
  a: CandidateAnalysis,
  industry: string,
  edges: BriefEdge[] = [],
): SectorBrief {
  const r = reasonArrays(a);
  const ddPct = a.drawdown?.drawdownFrom52wHighPercent;

  const bull = [
    ...(r.momentum ?? []).filter((x) => /above|uptrend|healthy|improving|strong/i.test(x)),
    ...(r.valuation ?? []).filter((x) => /below|discount|cheap|value|oversold/i.test(x)),
    ...edges.filter((e) => e.impactScore > 0).map((e) => e.title),
  ];
  const bear = [
    ...(r.momentum ?? []).filter((x) => /below|downtrend|weak|overbought/i.test(x)),
    ...(r.risk ?? []).filter((x) => /high|deep|worsening|negative|volatil/i.test(x)),
    ...edges.filter((e) => e.impactScore < 0).map((e) => e.title),
  ];

  const keyCatalysts = [
    ...edges.filter((e) => e.impactScore > 0).map((e) => e.title),
    ...(ddPct != null && ddPct < -10 ? [`Trading ${Math.abs(ddPct).toFixed(1)}% below its 52-week high`] : []),
  ].slice(0, 3);
  const keyRisks = [
    ...(r.risk ?? []).filter((x) => /high|deep|volatil/i.test(x)),
    ...edges.filter((e) => e.impactScore < 0).map((e) => e.title),
  ].slice(0, 3);

  const ddTxt = ddPct != null ? `${Math.abs(ddPct).toFixed(1)}% below its 52-week high` : "drawdown unknown";
  return {
    summary: `${a.ticker} (${industry}) scores ${a.score.overallScore.toFixed(1)}/10 (${a.score.recommendation}), trading ${ddTxt}.`,
    bullCase: bull.length > 0 ? bull.slice(0, 3).join(" ") : "No bullish technical signals tracked yet.",
    bearCase: bear.length > 0 ? bear.slice(0, 3).join(" ") : "No bearish technical signals tracked yet.",
    keyCatalysts,
    keyRisks,
    recommendedAction: a.score.recommendation,
    confidence: a.score.confidence,
    by: "rules",
  };
}

/** Full research brief for a pick — LLM when configured, rule-based otherwise. */
export async function generateSectorBrief(
  a: CandidateAnalysis,
  industry: string,
): Promise<SectorBrief> {
  const edges = edgeCatalystsForTicker(a.ticker);
  const fallback = ruleBriefFromAnalysis(a, industry, edges);
  const provider = getProvider();
  if (!provider) return fallback;

  const prompt = `You are a cautious swing-trading research assistant screening the "${industry}" industry. Using ONLY the data below, write a concise research brief for ${a.ticker}. Never claim certainty, never guarantee returns, always hedge. If data is missing, say so.

DATA (machine-collected):
Industry searched: ${industry}
Overall score: ${a.score.overallScore}/10 (${a.score.recommendation}, confidence ${a.score.confidence})
Score components: ${JSON.stringify(a.score.components)}
Score reasoning: ${JSON.stringify(reasonArrays(a))}
Latest price: ${a.price ?? "n/a"}
Drawdown from 52w high: ${a.drawdown?.drawdownFrom52wHighPercent?.toFixed(1) ?? "n/a"}%
Entity catalyst edges: ${JSON.stringify(edges.slice(0, 5).map((e) => ({ title: e.title, impact: e.impactScore })))}

Respond in strict JSON with keys: summary (1 sentence), bullCase (1-2 sentences), bearCase (1-2 sentences), keyCatalysts (array of short strings), keyRisks (array of short strings), recommendedAction (short phrase), confidence (low/medium/high).`;

  try {
    const raw = await provider.complete(prompt, { maxTokens: 700 });
    const jsonText = raw.match(/\{[\s\S]*\}/)?.[0];
    if (!jsonText) return fallback;
    const p = JSON.parse(jsonText) as Partial<SectorBrief>;
    return {
      summary: p.summary ?? fallback.summary,
      bullCase: p.bullCase ?? fallback.bullCase,
      bearCase: p.bearCase ?? fallback.bearCase,
      keyCatalysts: Array.isArray(p.keyCatalysts) ? p.keyCatalysts : fallback.keyCatalysts,
      keyRisks: Array.isArray(p.keyRisks) ? p.keyRisks : fallback.keyRisks,
      recommendedAction: p.recommendedAction ?? fallback.recommendedAction,
      confidence: p.confidence ?? fallback.confidence,
      by: "llm",
    };
  } catch {
    return fallback;
  }
}

// ----------------------------------------------------------------------------
// Scan orchestration + persistence
// ----------------------------------------------------------------------------

export interface SectorScanResult {
  industry: string;
  considered: number; // tickers the expander proposed
  scanned: number; // tickers with real data that got scored
  proposed: number; // picks that cleared the score test
  thesisReports: number; // deeper company-claim reports generated
  expandedBy: "llm" | "rules";
  minScore: number;
  picks: { ticker: string; score: number }[];
  errors: string[];
}

function thesisAdjustedScore(marketScore: number, thesisScore: number | null | undefined): number {
  return thesisScore == null ? marketScore : marketScore * 0.65 + thesisScore * 0.35;
}

/**
 * Scan an industry end-to-end and persist the picks. Re-running an industry
 * refreshes its un-acted ("new") picks while preserving any you've already
 * added or dismissed.
 */
export async function runSectorScan(opts: {
  industry: string;
  minScore?: number;
  maxCandidates?: number;
  cfg?: AppConfig;
}): Promise<SectorScanResult> {
  const cfg = opts.cfg ?? loadConfig();
  const industry = normalizeIndustryLabel(opts.industry);
  if (!industry) throw new Error("industry is required");
  const minScore = opts.minScore ?? cfg.agentMinScore;
  const maxCandidates = opts.maxCandidates ?? 24;
  const alpaca = AlpacaService.fromEnv();
  const db = getDb();
  const result: SectorScanResult = {
    industry,
    considered: 0,
    scanned: 0,
    proposed: 0,
    thesisReports: 0,
    expandedBy: "rules",
    minScore,
    picks: [],
    errors: [],
  };

  const expansion = await expandIndustry(industry, { max: maxCandidates });
  result.expandedBy = expansion.by;
  result.considered = expansion.tickers.length;

  const thesisBudget = cfg.sectorScoutThesisEnabled
    ? Math.min(maxCandidates, Math.max(0, cfg.sectorScoutThesisMaxReports))
    : 0;
  let thesisUsed = 0;
  const surfaced: {
    a: CandidateAnalysis;
    brief: SectorBrief;
    low: number | null;
    high: number | null;
    thesis: CompanyThesisReport | null;
    thesisReportId: number | null;
  }[] = [];
  for (const ticker of expansion.tickers) {
    try {
      const a = await analyzeTicker(ticker, alpaca, cfg);
      if (!a) continue; // no real bars/price -> validation drop
      result.scanned++;

      let thesis: CompanyThesisReport | null = null;
      let thesisReportId: number | null = null;
      if (thesisUsed < thesisBudget) {
        thesisUsed++;
        try {
          const res = await generateCompanyThesisReport({
            ticker: a.ticker,
            companyName: a.companyName,
            industry,
            cfg,
          });
          thesis = res.report;
          thesisReportId = res.reportId;
          result.thesisReports++;
        } catch (e) {
          result.errors.push(`${ticker} thesis: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      const marketPass = passesTest(a, minScore);
      const thesisPass =
        thesis != null && thesis.overallThesisScore >= cfg.sectorScoutThesisMinScore;
      if (!marketPass && !thesisPass) continue;

      const brief = await generateSectorBrief(a, industry);
      const { low, high } = suggestBuyZone(a);
      surfaced.push({ a, brief, low, high, thesis, thesisReportId });
    } catch (e) {
      result.errors.push(`${ticker}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  surfaced.sort(
    (x, y) =>
      thesisAdjustedScore(y.a.score.overallScore, y.thesis?.overallThesisScore) -
      thesisAdjustedScore(x.a.score.overallScore, x.thesis?.overallThesisScore),
  );

  // Refresh: drop this industry's un-acted picks, then upsert the current set.
  // Existing "added"/"dismissed" rows survive (their status is preserved on conflict).
  const now = nowIso();
  db.delete(schema.sectorScoutPicks)
    .where(and(eq(schema.sectorScoutPicks.industry, industry), eq(schema.sectorScoutPicks.status, "new")))
    .run();

  for (const { a, brief, low, high, thesis, thesisReportId } of surfaced) {
    const values = {
      industry,
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
      summary: brief.summary,
      bullCase: brief.bullCase,
      bearCase: brief.bearCase,
      keyCatalysts: JSON.stringify(brief.keyCatalysts),
      keyRisks: JSON.stringify(brief.keyRisks),
      recommendedAction: brief.recommendedAction,
      briefGeneratedBy: brief.by,
      thesisReportId,
      thesisScore: thesis?.overallThesisScore ?? null,
      themeFitScore: thesis?.themeFitScore ?? null,
      claimCredibilityScore: thesis?.claimCredibilityScore ?? null,
      moonshotScore: thesis?.moonshotScore ?? null,
      evidenceQualityScore: thesis?.evidenceQualityScore ?? null,
      hypePenalty: thesis?.hypePenalty ?? null,
      thesisVerdict: thesis?.verdict ?? null,
      thesisSummary: thesis?.summary ?? null,
      thesisGeneratedBy: thesis?.generatedBy ?? null,
      scannedAt: now,
    };
    db.insert(schema.sectorScoutPicks)
      .values({ ...values, status: "new" })
      // Preserve status (added/dismissed) on re-scan: update everything but status.
      .onConflictDoUpdate({
        target: [schema.sectorScoutPicks.industry, schema.sectorScoutPicks.ticker],
        set: values,
      })
      .run();
    result.proposed++;
    result.picks.push({ ticker: a.ticker, score: a.score.overallScore });
  }
  result.picks.sort((x, y) => y.score - x.score);

  db.insert(schema.sectorScans)
    .values({
      industry,
      considered: result.considered,
      scanned: result.scanned,
      proposed: result.proposed,
      thesisReports: result.thesisReports,
      minScore,
      expandedBy: result.expandedBy,
      ranAt: now,
    })
    .run();

  return result;
}

// ----------------------------------------------------------------------------
// Read + actions
// ----------------------------------------------------------------------------

export type SectorPick = typeof schema.sectorScoutPicks.$inferSelect;

/** Picks for the dashboard, newest-scanned industries first, best score first. */
export function listSectorPicks(industry?: string): SectorPick[] {
  const db = getDb();
  const rows = industry
    ? db
        .select()
        .from(schema.sectorScoutPicks)
        .where(eq(schema.sectorScoutPicks.industry, normalizeIndustryLabel(industry)))
        .all()
    : db.select().from(schema.sectorScoutPicks).all();
  return rows
    .filter((r) => r.status !== "dismissed")
    .sort((a, b) => {
      if (a.industry !== b.industry) return b.scannedAt.localeCompare(a.scannedAt);
      return thesisAdjustedScore(b.overallScore, b.thesisScore) - thesisAdjustedScore(a.overallScore, a.thesisScore);
    });
}

export function listSectorScans(limit = 20) {
  const db = getDb();
  return db
    .select()
    .from(schema.sectorScans)
    .orderBy(desc(schema.sectorScans.ranAt))
    .limit(limit)
    .all();
}

/** Promote a pick into the real watchlist and mark it added. */
export function acceptSectorPick(id: number): { ok: true; ticker: string } | { error: string } {
  const db = getDb();
  const p = db.select().from(schema.sectorScoutPicks).where(eq(schema.sectorScoutPicks.id, id)).get();
  if (!p) return { error: "pick not found" };
  const now = nowIso();
  const values = {
    ticker: p.ticker,
    companyName: p.companyName ?? null,
    targetBuyLow: p.suggestedBuyLow ?? null,
    targetBuyHigh: p.suggestedBuyHigh ?? null,
    notes: `Added from Sector Scout (${p.industry}) — ${p.summary ?? "scout-proposed"}${
      p.thesisSummary ? ` Thesis: ${p.thesisSummary}` : ""
    }`.slice(0, 500),
    updatedAt: now,
  };
  db.insert(schema.watchlistItems)
    .values({ ...values, createdAt: now })
    .onConflictDoUpdate({ target: schema.watchlistItems.ticker, set: values })
    .run();
  db.update(schema.sectorScoutPicks)
    .set({ status: "added" })
    .where(eq(schema.sectorScoutPicks.id, id))
    .run();
  return { ok: true, ticker: p.ticker };
}

export function dismissSectorPick(id: number): { ok: true } | { error: string } {
  const db = getDb();
  const p = db.select().from(schema.sectorScoutPicks).where(eq(schema.sectorScoutPicks.id, id)).get();
  if (!p) return { error: "pick not found" };
  db.update(schema.sectorScoutPicks)
    .set({ status: "dismissed" })
    .where(eq(schema.sectorScoutPicks.id, id))
    .run();
  return { ok: true };
}
