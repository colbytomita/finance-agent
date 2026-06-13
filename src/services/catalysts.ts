import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { CatalystType, Confidence, ImpactDirection } from "@/lib/types";

// Source-agnostic catalyst ingestion + keyword classification.
// MVP sources: manual entry, Yahoo news headlines (via browser connector).
// The classifier is heuristic — every result is marked with confidence and
// the UI labels it as model-generated interpretation, not fact.

export interface ClassifiedCatalyst {
  catalystType: CatalystType;
  impactDirection: ImpactDirection;
  impactScore: number; // -5..+5
  confidence: Confidence;
  tags: string[];
}

interface KeywordRule {
  type: CatalystType;
  pattern: RegExp;
  direction: ImpactDirection;
  impact: number;
}

const RULES: KeywordRule[] = [
  { type: "earnings", pattern: /\b(earnings|quarterly results|q[1-4] (results|report)|eps (beat|miss)|revenue (beat|miss))\b/i, direction: "unknown", impact: 0 },
  { type: "earnings", pattern: /\b(beats?|tops?|exceeds?) (estimates|expectations|forecasts)\b/i, direction: "positive", impact: 3 },
  { type: "earnings", pattern: /\b(misses?|falls? short of) (estimates|expectations|forecasts)\b/i, direction: "negative", impact: -3 },
  { type: "guidance_update", pattern: /\b(raises?|hikes?|boosts?|lifts?) (guidance|outlook|forecast)\b/i, direction: "positive", impact: 4 },
  { type: "guidance_update", pattern: /\b(cuts?|lowers?|slashes?|withdraws?) (guidance|outlook|forecast)\b/i, direction: "negative", impact: -4 },
  { type: "analyst_action", pattern: /\b(upgrades?|upgraded|raises? (price target|pt)|initiates? .{0,20}(buy|outperform|overweight))\b/i, direction: "positive", impact: 2 },
  { type: "analyst_action", pattern: /\b(downgrades?|downgraded|cuts? (price target|pt)|initiates? .{0,20}(sell|underperform|underweight))\b/i, direction: "negative", impact: -2 },
  { type: "ma", pattern: /\b(acquires?|acquisition|merger|buyout|takeover|to acquire|to buy)\b/i, direction: "mixed", impact: 2 },
  { type: "product_launch", pattern: /\b(launches?|unveils?|debuts?|releases?|introduces?) (new |its |the )?\w/i, direction: "positive", impact: 2 },
  { type: "ai_technology", pattern: /\b(ai|artificial intelligence|machine learning|llm|chip|semiconductor|data center)\b/i, direction: "positive", impact: 1 },
  { type: "regulatory", pattern: /\b(fda|sec investigation|antitrust|doj|ftc|regulator|approval|approves?|clearance)\b/i, direction: "unknown", impact: 0 },
  { type: "regulatory", pattern: /\b(fda approval|approves?|clearance granted|wins? approval)\b/i, direction: "positive", impact: 4 },
  { type: "regulatory", pattern: /\b(probe|investigation|fine[sd]?|penalty|lawsuit blocked|rejects?|denies? approval)\b/i, direction: "negative", impact: -3 },
  { type: "litigation", pattern: /\b(lawsuit|sues?|sued|litigation|settlement|class action)\b/i, direction: "negative", impact: -2 },
  { type: "dividend_buyback", pattern: /\b(dividend (increase|hike|raise)|buyback|share repurchase)\b/i, direction: "positive", impact: 2 },
  { type: "dividend_buyback", pattern: /\b(dividend (cut|suspension|suspended))\b/i, direction: "negative", impact: -4 },
  { type: "insider_trading", pattern: /\b(insider (buying|purchases?)|ceo (buys?|purchased))\b/i, direction: "positive", impact: 2 },
  { type: "insider_trading", pattern: /\b(insider selling|ceo (sells?|sold))\b/i, direction: "negative", impact: -1 },
  { type: "executive_announcement", pattern: /\b(ceo|cfo|coo|chief \w+ officer) (steps? down|resigns?|departs?|fired|ousted)\b/i, direction: "negative", impact: -3 },
  { type: "executive_announcement", pattern: /\b(names?|appoints?|hires?) (new )?(ceo|cfo|coo|chief)\b/i, direction: "mixed", impact: 0 },
  { type: "macro", pattern: /\b(fed|fomc|interest rate|inflation|cpi|ppi|jobs report|nonfarm|gdp|tariff)\b/i, direction: "unknown", impact: 0 },
  { type: "conference", pattern: /\b(conference|summit|keynote|expo|investor day|analyst day)\b/i, direction: "unknown", impact: 0 },
  { type: "investor_day", pattern: /\b(investor day|capital markets day)\b/i, direction: "unknown", impact: 1 },
];

const NEGATIVE_TONE = /\b(plunges?|sinks?|tumbles?|crashes?|warns?|recall|halts?|layoffs?|bankrupt|default|shortfall|disappoint\w*)\b/i;
const POSITIVE_TONE = /\b(soars?|surges?|jumps?|rallies|record (high|revenue|profit)|wins?|breakthrough|strong demand)\b/i;

export function classifyCatalyst(title: string, summary = ""): ClassifiedCatalyst {
  const text = `${title} ${summary}`;
  let best: KeywordRule | null = null;
  const tags: string[] = [];
  for (const rule of RULES) {
    if (rule.pattern.test(text)) {
      tags.push(rule.type);
      // Prefer the rule with the strongest absolute impact.
      if (!best || Math.abs(rule.impact) > Math.abs(best.impact)) best = rule;
    }
  }
  let impact = best?.impact ?? 0;
  let direction: ImpactDirection = best?.direction ?? "unknown";

  // Tone adjustment for otherwise-neutral matches.
  if (NEGATIVE_TONE.test(text)) {
    impact = Math.min(impact - 1, -1);
    direction = impact < 0 ? "negative" : direction;
    tags.push("negative-tone");
  } else if (POSITIVE_TONE.test(text)) {
    impact = Math.max(impact + 1, 1);
    direction = impact > 0 ? "positive" : direction;
    tags.push("positive-tone");
  }
  impact = Math.max(-5, Math.min(5, impact));
  if (impact > 0 && direction === "unknown") direction = "positive";
  if (impact < 0 && direction === "unknown") direction = "negative";

  // Keyword classification is inherently low/medium confidence.
  const confidence: Confidence = best && Math.abs(impact) >= 3 ? "medium" : "low";

  return {
    catalystType: best?.type ?? "industry_news",
    impactDirection: direction,
    impactScore: impact,
    confidence,
    tags: [...new Set(tags)],
  };
}

export interface NewCatalyst {
  ticker?: string | null;
  industry?: string | null;
  title: string;
  summary?: string | null;
  sourceUrl?: string | null;
  sourceName?: string;
  catalystType?: CatalystType;
  eventDate?: string | null;
  impactDirection?: ImpactDirection;
  impactScore?: number;
  confidence?: Confidence;
  status?: "upcoming" | "occurred" | "expired";
}

export function addCatalyst(input: NewCatalyst): number {
  const db = getDb();
  // Auto-classify anything the user/source didn't specify.
  const auto = classifyCatalyst(input.title, input.summary ?? "");
  const ticker = input.ticker?.toUpperCase() ?? null;

  const affectsActiveTrade = ticker
    ? db
        .select()
        .from(schema.activeTrades)
        .where(eq(schema.activeTrades.ticker, ticker))
        .all()
        .some((t) => t.status === "open")
    : false;

  const result = db
    .insert(schema.catalysts)
    .values({
      ticker,
      industry: input.industry ?? null,
      title: input.title,
      summary: input.summary ?? null,
      sourceUrl: input.sourceUrl ?? null,
      sourceName: input.sourceName ?? "manual",
      catalystType: input.catalystType ?? auto.catalystType,
      eventDate: input.eventDate ?? null,
      discoveredAt: new Date().toISOString(),
      impactDirection: input.impactDirection ?? auto.impactDirection,
      impactScore: input.impactScore ?? auto.impactScore,
      confidence: input.confidence ?? auto.confidence,
      status:
        input.status ??
        (input.eventDate && new Date(input.eventDate).getTime() > Date.now()
          ? "upcoming"
          : "occurred"),
      tags: auto.tags.join(","),
      affectsActiveTrade,
    })
    .run();
  return Number(result.lastInsertRowid);
}

/** Mark past-dated "upcoming" catalysts as occurred. */
export function rollCatalystStatuses(): void {
  const db = getDb();
  const upcoming = db
    .select()
    .from(schema.catalysts)
    .where(eq(schema.catalysts.status, "upcoming"))
    .all();
  const now = Date.now();
  for (const c of upcoming) {
    if (c.eventDate && new Date(c.eventDate).getTime() < now) {
      db.update(schema.catalysts)
        .set({ status: "occurred" })
        .where(eq(schema.catalysts.id, c.id))
        .run();
    }
  }
}

/** Best-effort Yahoo Finance news scan for tracked tickers (browser connector). */
export async function scanYahooNews(tickers: string[]): Promise<number> {
  const { getYahooService } = await import("./yahooFinanceBrowser");
  const yahoo = getYahooService();
  const db = getDb();
  let added = 0;
  for (const ticker of tickers) {
    const page = await yahoo.getQuotePage(ticker).catch(() => null);
    if (!page) continue;
    // Headlines appear as <a ...><h3>Title</h3></a> or section[data-testid=news] links.
    const headlineRe = /<h3[^>]*>([^<]{20,200})<\/h3>/gi;
    const existing = new Set(
      db
        .select({ title: schema.catalysts.title })
        .from(schema.catalysts)
        .where(eq(schema.catalysts.ticker, ticker.toUpperCase()))
        .all()
        .map((r) => r.title),
    );
    let m: RegExpExecArray | null;
    let count = 0;
    while ((m = headlineRe.exec(page.html)) !== null && count < 5) {
      const title = m[1].replace(/&amp;/g, "&").replace(/&#x27;|&apos;/g, "'").trim();
      if (!title || existing.has(title)) continue;
      addCatalyst({
        ticker,
        title,
        sourceName: "yahoo-news",
        sourceUrl: page.url,
        status: "occurred",
      });
      added++;
      count++;
    }
  }
  return added;
}

export function getCatalystsForTicker(ticker: string) {
  const db = getDb();
  return db
    .select()
    .from(schema.catalysts)
    .where(eq(schema.catalysts.ticker, ticker.toUpperCase()))
    .orderBy(desc(schema.catalysts.discoveredAt))
    .all();
}
