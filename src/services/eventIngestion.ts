import { desc, eq } from "drizzle-orm";
import type { Confidence, ImpactDirection } from "@/lib/types";
import { getDb, schema } from "@/db";
import { loadConfig } from "@/lib/config";
import { addMention, listMentions, distinctEntities, type MentionDirection } from "./entityMentions";
import { addCatalyst } from "./catalysts";
import { extractEvents, type ExtractedEvent } from "./eventExtraction";
import type { RawEventItem } from "./sources/types";
import { fetchEdgarFilings } from "./sources/secEdgar";
import { fetchGdeltNews, buildGdeltQueriesFor, type GdeltQueryItem } from "./sources/gdelt";
import { fetchIrFeeds, type IrFeed } from "./sources/irRss";
import { makeResolver } from "./sources/tickerMap";

// Orchestrates real-world event ingestion: pull from the enabled source
// connectors, extract structured mentions (Haiku + rule-based fallback), dedupe,
// and persist as entity_mentions (and optionally as catalysts so they appear in
// the existing catalyst views). Cost is controlled by Haiku + batching + an
// item cap. Sources/queries/feeds/caps come from config but can be overridden
// per-run (the manual "Run ingestion" button and tests pass overrides).

const RANK: Record<Confidence, number> = { low: 1, medium: 2, high: 3 };
export function confidenceRank(c: Confidence): number {
  return RANK[c] ?? 1;
}

/** Stable key for de-duplicating mentions across runs. */
export function dedupeKey(
  entity: string,
  ticker: string,
  eventDate: string,
  ref: string,
): string {
  return [entity.trim().toLowerCase(), ticker.toUpperCase(), eventDate.slice(0, 10), ref]
    .join("|");
}

function mentionToImpact(d: MentionDirection): ImpactDirection {
  return d === "bullish" ? "positive" : d === "bearish" ? "negative" : d === "neutral" ? "mixed" : "unknown";
}

/**
 * Companies to auto-derive GDELT queries from: everything you actively track —
 * watchlist, holdings, then current (pending) agent picks, newest first. Only
 * pending candidates count: accepted ones are already promoted into the
 * watchlist (covered above), and declined ones aren't tracked at all — including
 * them would waste the per-run query budget on names you've dismissed. De-duping
 * by ticker happens in buildGdeltQueriesFor, so order just sets priority within
 * the cap.
 */
function trackedCompaniesForGdelt(): GdeltQueryItem[] {
  const db = getDb();
  const out: GdeltQueryItem[] = [];
  out.push(
    ...db
      .select({ ticker: schema.watchlistItems.ticker, companyName: schema.watchlistItems.companyName })
      .from(schema.watchlistItems)
      .all(),
  );
  out.push(
    ...db
      .select({ ticker: schema.portfolioHoldings.ticker, companyName: schema.portfolioHoldings.companyName })
      .from(schema.portfolioHoldings)
      .all(),
  );
  out.push(
    ...db
      .select({ ticker: schema.agentCandidates.ticker, companyName: schema.agentCandidates.companyName })
      .from(schema.agentCandidates)
      .where(eq(schema.agentCandidates.status, "pending"))
      .orderBy(desc(schema.agentCandidates.proposedAt))
      .all(),
  );
  return out;
}

/**
 * Every tracked ticker + company name (all four tables, all statuses), deduped.
 * Augments the extraction resolver so news/filings about smaller tracked names —
 * outside the curated universe — still map to the right ticker instead of being
 * dropped. Unlike the GDELT-query set, this is broad on purpose (no per-run cap).
 */
function trackedTickerHints(): { ticker: string; name: string | null }[] {
  const db = getDb();
  const out: { ticker: string; name: string | null }[] = [];
  const seen = new Set<string>();
  const add = (ticker: string | null, name: string | null) => {
    if (!ticker) return;
    const t = ticker.toUpperCase();
    if (seen.has(t)) return;
    seen.add(t);
    out.push({ ticker: t, name });
  };
  for (const r of db.select({ ticker: schema.watchlistItems.ticker, name: schema.watchlistItems.companyName }).from(schema.watchlistItems).all())
    add(r.ticker, r.name);
  for (const r of db.select({ ticker: schema.portfolioHoldings.ticker, name: schema.portfolioHoldings.companyName }).from(schema.portfolioHoldings).all())
    add(r.ticker, r.name);
  for (const r of db.select({ ticker: schema.agentCandidates.ticker, name: schema.agentCandidates.companyName }).from(schema.agentCandidates).all())
    add(r.ticker, r.name);
  for (const r of db.select({ ticker: schema.sectorScoutPicks.ticker, name: schema.sectorScoutPicks.companyName }).from(schema.sectorScoutPicks).all())
    add(r.ticker, r.name);
  return out;
}

function sourceLabel(source: string): string {
  if (source.startsWith("sec")) return "SEC EDGAR";
  if (source.startsWith("gdelt")) return "GDELT News";
  if (source.startsWith("ir-rss:")) return `IR feed (${source.slice("ir-rss:".length)})`;
  return source;
}

export interface IngestOptions {
  sources?: { sec?: boolean; gdelt?: boolean; ir?: boolean };
  gdeltQueries?: string[];
  irFeeds?: IrFeed[];
  maxItems?: number;
  minConfidence?: Confidence;
  /** Also write each mention into the catalysts table. Default false. */
  alsoCreateCatalysts?: boolean;
  fetchFn?: typeof fetch;
}

export interface IngestResult {
  fetched: number;
  extracted: number;
  persisted: number;
  catalystsAdded: number;
  skipped: number;
  bySource: Record<string, number>;
  errors: string[];
  generatedBy: "llm" | "rules" | "mixed" | "none";
}

export async function runEventIngestion(opts: IngestOptions = {}): Promise<IngestResult> {
  const cfg = loadConfig();
  const sources = {
    sec: opts.sources?.sec ?? cfg.eventSourceSecEnabled,
    gdelt: opts.sources?.gdelt ?? cfg.eventSourceGdeltEnabled,
    ir: opts.sources?.ir ?? cfg.eventSourceIrEnabled,
  };
  let gdeltQueries = opts.gdeltQueries ?? cfg.gdeltQueries;
  // Auto-derive queries from the companies you track so enabling GDELT works out
  // of the box. Only when the source is on, the caller passed no queries, and
  // none are configured — an explicit/configured list always wins.
  if (sources.gdelt && opts.gdeltQueries === undefined && gdeltQueries.length === 0) {
    gdeltQueries = buildGdeltQueriesFor(trackedCompaniesForGdelt());
  }
  const irFeeds = opts.irFeeds ?? cfg.irFeeds;
  const maxItems = opts.maxItems ?? cfg.eventIngestionMaxItems;
  const minConfidence = opts.minConfidence ?? cfg.eventMinConfidence;

  const result: IngestResult = {
    fetched: 0,
    extracted: 0,
    persisted: 0,
    catalystsAdded: 0,
    skipped: 0,
    bySource: {},
    errors: [],
    generatedBy: "none",
  };

  // 1. Gather raw items from enabled sources.
  const raw: RawEventItem[] = [];
  if (sources.sec) {
    try {
      const items = await fetchEdgarFilings({ max: maxItems, fetchFn: opts.fetchFn });
      raw.push(...items);
      result.bySource["sec-edgar"] = items.length;
    } catch (e) {
      result.errors.push(`sec-edgar: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (sources.gdelt && gdeltQueries.length > 0) {
    try {
      const items = await fetchGdeltNews(gdeltQueries, { fetchFn: opts.fetchFn });
      raw.push(...items);
      result.bySource["gdelt"] = items.length;
    } catch (e) {
      result.errors.push(`gdelt: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (sources.ir && irFeeds.length > 0) {
    try {
      const items = await fetchIrFeeds(irFeeds, { fetchFn: opts.fetchFn });
      raw.push(...items);
      result.bySource["ir-rss"] = items.length;
    } catch (e) {
      result.errors.push(`ir-rss: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const capped = raw.slice(0, maxItems);
  result.fetched = capped.length;
  if (capped.length === 0) return result;

  // 2. Extract structured events (one batched LLM call; rule-based fallback).
  // The resolver knows the curated universe PLUS everything you track, so news
  // about smaller tracked names still maps to a ticker instead of being dropped.
  const knownEntities = distinctEntities().map((e) => e.entity);
  const resolver = makeResolver(trackedTickerHints());
  let extracted: ExtractedEvent[];
  try {
    extracted = await extractEvents(capped, { knownEntities, resolver });
  } catch (e) {
    result.errors.push(`extraction: ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }
  result.extracted = extracted.length;
  const llmCount = extracted.filter((e) => e.generatedBy === "llm").length;
  result.generatedBy =
    extracted.length === 0
      ? "none"
      : llmCount === extracted.length
        ? "llm"
        : llmCount === 0
          ? "rules"
          : "mixed";

  // 3. Dedupe against everything already stored, then persist.
  const minRank = confidenceRank(minConfidence);
  const seen = new Set(
    listMentions().map((m) =>
      dedupeKey(m.entity, m.ticker, m.eventDate, m.sourceUrl ?? m.claim ?? ""),
    ),
  );

  for (const ev of extracted) {
    if (!ev.entity || !ev.ticker) {
      result.skipped++;
      continue;
    }
    if (confidenceRank(ev.confidence) < minRank) {
      result.skipped++;
      continue;
    }
    const key = dedupeKey(ev.entity, ev.ticker, ev.eventDate, ev.url || ev.claim || "");
    if (seen.has(key)) {
      result.skipped++;
      continue;
    }
    seen.add(key);

    addMention({
      entity: ev.entity,
      ticker: ev.ticker,
      claim: ev.claim,
      direction: ev.direction,
      eventDate: ev.eventDate,
      sourceName: sourceLabel(ev.source),
      sourceUrl: ev.url || null,
    });
    result.persisted++;

    if (opts.alsoCreateCatalysts) {
      addCatalyst({
        ticker: ev.ticker,
        title: ev.claim || ev.title,
        summary: `${ev.entity}: ${ev.claim ?? ev.title}`,
        sourceUrl: ev.url || null,
        sourceName: sourceLabel(ev.source),
        eventDate: ev.eventDate,
        impactDirection: mentionToImpact(ev.direction),
        confidence: ev.confidence,
      });
      result.catalystsAdded++;
    }
  }

  return result;
}
