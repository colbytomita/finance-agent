import { and, desc, eq, ne } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { loadConfig } from "@/lib/config";
import { nowIso } from "@/lib/util";
import type { CatalystType, Confidence, ImpactDirection } from "@/lib/types";

/**
 * sourceName for the auto-fetched "upcoming earnings date" schedule markers.
 * These feed the earnings-proximity guard (daysToNextEarnings) but are held
 * OUT of the catalyst/sentiment scoring blend — a future date with unknown
 * direction is a schedule signal, not a directional catalyst. getCatalystInputs
 * filters this source out for exactly that reason.
 */
export const EARNINGS_CALENDAR_SOURCE = "yahoo-calendar";

const earningsMarkerTitle = (date: string) => `Upcoming earnings (estimated) ~${date}`;

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

  // Tone nudges the impact but never forces it across zero (roadmap #44): a
  // strong rule match ("raises guidance", +4) with one negative-tone word
  // ("warns") softens to +3 — it must not flip to negative. With no rule
  // match, tone sets the ±1 as before.
  if (NEGATIVE_TONE.test(text)) {
    impact = impact === 0 ? -1 : impact > 0 ? Math.max(impact - 1, 0) : impact - 1;
    direction = impact < 0 ? "negative" : direction;
    tags.push("negative-tone");
  } else if (POSITIVE_TONE.test(text)) {
    impact = impact === 0 ? 1 : impact < 0 ? Math.min(impact + 1, 0) : impact + 1;
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
      discoveredAt: nowIso(),
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
/**
 * When a catalyst's event effectively happened: its event date if known,
 * otherwise when we discovered it. Used to decide whether it's still "current".
 */
export function catalystEffectiveTime(c: {
  eventDate: string | null;
  discoveredAt: string;
}): number {
  const t = c.eventDate ? new Date(c.eventDate).getTime() : NaN;
  return Number.isFinite(t) ? t : new Date(c.discoveredAt).getTime();
}

/**
 * A catalyst is stale once its event is more than `freshnessDays` in the past —
 * e.g. a 2-year-old entity mention should not be presented as a current risk or
 * keep moving the score. Future-dated (upcoming) catalysts are never stale.
 */
export function isCatalystStale(
  c: { eventDate: string | null; discoveredAt: string },
  freshnessDays: number,
  now: number = Date.now(),
): boolean {
  return catalystEffectiveTime(c) < now - freshnessDays * 86400000;
}

export function rollCatalystStatuses(): void {
  const db = getDb();
  const freshnessDays = loadConfig().catalystFreshnessDays;
  const now = Date.now();
  // Walk every non-expired catalyst: promote upcoming events whose date has
  // passed, then age out anything whose event is well in the past so stale items
  // drop out of current views and stop influencing scores.
  const rows = db
    .select()
    .from(schema.catalysts)
    .where(ne(schema.catalysts.status, "expired"))
    .all();
  for (const c of rows) {
    let status = c.status;
    if (status === "upcoming" && c.eventDate && new Date(c.eventDate).getTime() < now) {
      status = "occurred";
    }
    if (status !== "upcoming" && isCatalystStale(c, freshnessDays, now)) {
      status = "expired";
    }
    if (status !== c.status) {
      db.update(schema.catalysts)
        .set({ status })
        .where(eq(schema.catalysts.id, c.id))
        .run();
    }
  }
}

/**
 * Best-effort Yahoo Finance news scan for tracked tickers. Primary source is
 * Yahoo's public per-ticker RSS feed (plain HTTP; real article links and
 * publish dates); the layout-fragile browser page-scrape remains only as a
 * fallback for tickers whose feed comes back empty.
 */
export async function scanYahooNews(tickers: string[]): Promise<number> {
  const db = getDb();
  let added = 0;
  for (const ticker of tickers) {
    const existing = new Set(
      db
        .select({ title: schema.catalysts.title })
        .from(schema.catalysts)
        .where(eq(schema.catalysts.ticker, ticker.toUpperCase()))
        .all()
        .map((r) => r.title),
    );
    const record = (title: string, sourceUrl: string, eventDate: string | null): boolean => {
      if (!title || existing.has(title)) return false;
      existing.add(title);
      addCatalyst({ ticker, title, sourceName: "yahoo-news", sourceUrl, eventDate, status: "occurred" });
      added++;
      return true;
    };

    const { getYahooHeadlines } = await import("./yahooHttp");
    const entries = await getYahooHeadlines(ticker);
    if (entries.length > 0) {
      // Only the top of the feed: examining (not adding) up to 5 entries keeps
      // repeated scans from crawling ever deeper and ingesting the whole feed.
      for (const e of entries.filter((x) => x.title.length >= 20).slice(0, 5)) {
        record(e.title, e.link, e.date);
      }
      continue;
    }

    const { getYahooService } = await import("./yahooFinanceBrowser");
    const page = await getYahooService().getQuotePage(ticker).catch(() => null);
    if (!page) continue;
    // Headlines appear as <a ...><h3>Title</h3></a> or section[data-testid=news] links.
    const headlineRe = /<h3[^>]*>([^<]{20,200})<\/h3>/gi;
    let m: RegExpExecArray | null;
    let count = 0;
    while ((m = headlineRe.exec(page.html)) !== null && count < 5) {
      const title = m[1].replace(/&amp;/g, "&").replace(/&#x27;|&apos;/g, "'").trim();
      if (record(title, page.url, null)) count++;
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

/**
 * Create or update the single auto-fetched "upcoming earnings" schedule marker
 * for a ticker (source {@link EARNINGS_CALENDAR_SOURCE}). Idempotent: the date
 * is updated in place when the schedule moves rather than stacked, and any
 * accidental duplicates are collapsed so `daysToNextEarnings` stays clean.
 * Returns what happened so the scheduler can report insert/update counts.
 */
export function upsertUpcomingEarningsCatalyst(
  ticker: string,
  eventDate: string,
): "inserted" | "updated" | "unchanged" {
  const db = getDb();
  const t = ticker.toUpperCase();
  const date = eventDate.slice(0, 10);
  const existing = db
    .select()
    .from(schema.catalysts)
    .where(
      and(
        eq(schema.catalysts.ticker, t),
        eq(schema.catalysts.catalystType, "earnings"),
        eq(schema.catalysts.status, "upcoming"),
        eq(schema.catalysts.sourceName, EARNINGS_CALENDAR_SOURCE),
      ),
    )
    .all();

  if (existing.length > 0) {
    const [keep, ...dups] = existing;
    for (const dup of dups) {
      db.delete(schema.catalysts).where(eq(schema.catalysts.id, dup.id)).run();
    }
    if (keep.eventDate?.slice(0, 10) === date) return "unchanged";
    db.update(schema.catalysts)
      .set({ eventDate: date, title: earningsMarkerTitle(date), discoveredAt: nowIso() })
      .where(eq(schema.catalysts.id, keep.id))
      .run();
    return "updated";
  }

  addCatalyst({
    ticker: t,
    title: earningsMarkerTitle(date),
    catalystType: "earnings",
    eventDate: date,
    sourceName: EARNINGS_CALENDAR_SOURCE,
    status: "upcoming",
    impactScore: 0,
    impactDirection: "unknown",
    confidence: "low",
  });
  return "inserted";
}
