import { desc, eq } from "drizzle-orm";
import type { Confidence, ImpactDirection } from "@/lib/types";
import { getDb, schema } from "@/db";
import { loadConfig } from "@/lib/config";
import { addMention, listMentions, distinctEntities, type MentionDirection } from "./entityMentions";
import { addCatalyst } from "./catalysts";
import { alertWatchedEntities, type EntityMentionBatch } from "./watchedEntities";
import { extractEvents, type ExtractedEvent } from "./eventExtraction";
import type { RawEventItem } from "./sources/types";
import { fetchEdgarFilings } from "./sources/secEdgar";
import {
  fetchGdeltNews,
  buildGdeltQueriesFor,
  describeGdeltFailures,
  rotateQueries,
  type GdeltQueryItem,
} from "./sources/gdelt";
import { fetchIrFeeds, type IrFeed } from "./sources/irRss";
import { makeResolver } from "./sources/tickerMap";
import { errorMessage, nowIso } from "@/lib/util";

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
  /** What kicked off this run — recorded in the run log. Default "manual". */
  trigger?: "manual" | "scheduled";
}

/** One skipped extraction with why it was dropped (capped per run). */
export interface SkippedItem {
  title: string;
  reason: string;
}

/** Cap on per-item skip details kept per run (the count is always exact). */
export const MAX_SKIPPED_ITEMS = 20;

/**
 * Cap raw items across sources fairly: take one item per source per round
 * (preserving each source's own newest-first order) until the cap is reached.
 * A plain concat-then-slice lets one chatty source starve the rest — SEC's
 * recent-filings feed always fills its fetch size, which used to push every
 * GDELT/IR item past the cap and out of the extraction batch entirely.
 */
export function capAcrossSources<T>(lists: T[][], max: number): T[] {
  const out: T[] = [];
  for (let round = 0; out.length < max; round++) {
    let took = false;
    for (const list of lists) {
      if (round >= list.length) continue;
      out.push(list[round]);
      took = true;
      if (out.length >= max) break;
    }
    if (!took) break;
  }
  return out;
}

export interface IngestResult {
  fetched: number;
  extracted: number;
  persisted: number;
  catalystsAdded: number;
  skipped: number;
  skippedItems: SkippedItem[];
  bySource: Record<string, number>;
  errors: string[];
  generatedBy: "llm" | "rules" | "mixed" | "none";
}

async function ingestCore(opts: IngestOptions = {}): Promise<IngestResult> {
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
    skippedItems: [],
    bySource: {},
    errors: [],
    generatedBy: "none",
  };

  // 1. Gather raw items from enabled sources (kept per-source for a fair cap).
  const raw: RawEventItem[][] = [];
  if (sources.sec) {
    try {
      const items = await fetchEdgarFilings({ max: maxItems, fetchFn: opts.fetchFn });
      raw.push(items);
      result.bySource["sec-edgar"] = items.length;
    } catch (e) {
      result.errors.push(`sec-edgar: ${errorMessage(e)}`);
    }
  }
  if (sources.gdelt && gdeltQueries.length > 0) {
    try {
      // Rotate which batch leads by day (roadmap #56): when a run dies early
      // to throttling, coverage still cycles through every company over
      // successive days instead of starving the tail of the list.
      const rotated = rotateQueries(gdeltQueries, Math.floor(Date.now() / 86_400_000));
      const { items, failures } = await fetchGdeltNews(rotated, { fetchFn: opts.fetchFn });
      raw.push(items);
      result.bySource["gdelt"] = items.length;
      const failTotal =
        failures.throttled + failures.timedOut + failures.badPayload + failures.httpError;
      // A zero with failures is an OUTAGE, not "no news" — say so in the run
      // log (flows to ingestion_runs.errors_json and the /events run list).
      if (items.length === 0 && failTotal > 0) {
        result.errors.push(`gdelt: 0 items — ${describeGdeltFailures(failures)}`);
      }
    } catch (e) {
      result.errors.push(`gdelt: ${errorMessage(e)}`);
    }
  }
  if (sources.ir && irFeeds.length > 0) {
    try {
      const items = await fetchIrFeeds(irFeeds, { fetchFn: opts.fetchFn });
      raw.push(items);
      result.bySource["ir-rss"] = items.length;
    } catch (e) {
      result.errors.push(`ir-rss: ${errorMessage(e)}`);
    }
  }

  const capped = capAcrossSources(raw, maxItems);
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
    result.errors.push(`extraction: ${errorMessage(e)}`);
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

  const skip = (ev: ExtractedEvent, reason: string) => {
    result.skipped++;
    if (result.skippedItems.length < MAX_SKIPPED_ITEMS) {
      result.skippedItems.push({ title: (ev.claim || ev.title || "(untitled)").slice(0, 90), reason });
    }
  };
  // Track new mentions per entity so watched entities can raise one alert each.
  const newByEntity = new Map<string, EntityMentionBatch>();
  for (const ev of extracted) {
    if (!ev.ticker) {
      skip(ev, ev.entity ? "no ticker resolved" : "no entity or ticker extracted");
      continue;
    }
    if (!ev.entity) {
      skip(ev, "no entity extracted");
      continue;
    }
    if (confidenceRank(ev.confidence) < minRank) {
      skip(ev, `confidence "${ev.confidence}" below the "${minConfidence}" minimum`);
      continue;
    }
    const key = dedupeKey(ev.entity, ev.ticker, ev.eventDate, ev.url || ev.claim || "");
    if (seen.has(key)) {
      skip(ev, "duplicate of a stored mention");
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
    const batch = newByEntity.get(ev.entity) ?? { count: 0, tickers: new Set<string>() };
    batch.count++;
    batch.tickers.add(ev.ticker.toUpperCase());
    newByEntity.set(ev.entity, batch);

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

  // Alert on watched entities that got new mentions this run (deduped by emitAlert).
  alertWatchedEntities(newByEntity);

  return result;
}

/** Build the persisted run-summary row from an ingest result. Pure. */
export function ingestionRunRecord(result: IngestResult, trigger: string, ranAt: string) {
  return {
    trigger: trigger === "scheduled" ? "scheduled" : "manual",
    fetched: result.fetched,
    extracted: result.extracted,
    persisted: result.persisted,
    catalystsAdded: result.catalystsAdded,
    skipped: result.skipped,
    skippedJson: JSON.stringify(result.skippedItems ?? []),
    generatedBy: result.generatedBy,
    bySource: JSON.stringify(result.bySource ?? {}),
    errorCount: result.errors.length,
    errorsJson: JSON.stringify(result.errors.slice(0, 10)),
    ranAt,
  };
}

/**
 * Run ingestion and log the run so the Events page can show its history. The
 * inner core does the work; a logging failure never masks the actual result.
 */
export async function runEventIngestion(opts: IngestOptions = {}): Promise<IngestResult> {
  const result = await ingestCore(opts);
  try {
    getDb()
      .insert(schema.ingestionRuns)
      .values(ingestionRunRecord(result, opts.trigger ?? "manual", nowIso()))
      .run();
  } catch (e) {
    console.error("[eventIngestion] failed to log run:", errorMessage(e));
  }
  return result;
}

export type IngestionRun = typeof schema.ingestionRuns.$inferSelect;

/** Recent ingestion runs, newest first (for the Events page). */
export function listIngestionRuns(limit = 10): IngestionRun[] {
  return getDb()
    .select()
    .from(schema.ingestionRuns)
    .orderBy(desc(schema.ingestionRuns.ranAt))
    .limit(limit)
    .all();
}
