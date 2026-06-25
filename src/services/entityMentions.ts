import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { Bar } from "@/lib/types";
import { AlpacaService } from "./alpaca";
import { getBars, saveBars } from "./marketData";
import {
  eventStudy,
  aggregateEventStudies,
  type EventStudyResult,
  type EntityEdgeSummary,
} from "./eventStudy";

// IO/orchestration layer for the event-study ("catalyst edge") engine. The pure
// math lives in eventStudy.ts; here we read/write entity_mentions, backfill the
// price bars needed to cover old event dates, and pool a single entity's
// mentions into an edge summary. Everything degrades gracefully — an entity or
// ticker with too little data is reported (n/skip), never thrown.

const nowIso = () => new Date().toISOString();

export type MentionDirection = "bullish" | "bearish" | "neutral" | "unknown";

export interface MentionInput {
  entity: string;
  ticker: string;
  claim?: string | null;
  direction?: MentionDirection | null;
  eventDate: string; // ISO date (YYYY-MM-DD)
  sourceName?: string | null;
  sourceUrl?: string | null;
}

export type MentionRow = typeof schema.entityMentions.$inferSelect;

export function addMention(input: MentionInput): number {
  const db = getDb();
  const row = db
    .insert(schema.entityMentions)
    .values({
      entity: input.entity.trim(),
      ticker: input.ticker.trim().toUpperCase(),
      claim: input.claim?.trim() || null,
      direction: input.direction ?? "unknown",
      eventDate: input.eventDate.slice(0, 10),
      sourceName: input.sourceName?.trim() || null,
      sourceUrl: input.sourceUrl?.trim() || null,
      createdAt: nowIso(),
    })
    .run();
  return Number(row.lastInsertRowid);
}

export function listMentions(filter?: { entity?: string; ticker?: string }): MentionRow[] {
  const db = getDb();
  const conds = [];
  if (filter?.entity) conds.push(eq(schema.entityMentions.entity, filter.entity));
  if (filter?.ticker) conds.push(eq(schema.entityMentions.ticker, filter.ticker.toUpperCase()));
  const where = conds.length === 1 ? conds[0] : conds.length > 1 ? and(...conds) : undefined;
  const q = db.select().from(schema.entityMentions);
  const rows = where ? q.where(where).all() : q.all();
  // Newest event first.
  return rows.sort((a, b) => (b.eventDate ?? "").localeCompare(a.eventDate ?? ""));
}

export function deleteMention(id: number): { ok: true } | { error: string } {
  const db = getDb();
  const existing = db
    .select({ id: schema.entityMentions.id })
    .from(schema.entityMentions)
    .where(eq(schema.entityMentions.id, id))
    .get();
  if (!existing) return { error: "mention not found" };
  db.delete(schema.entityMentions).where(eq(schema.entityMentions.id, id)).run();
  return { ok: true };
}

/** Distinct entities with how many mentions each has (for pickers/summaries). */
export function distinctEntities(): { entity: string; count: number }[] {
  const db = getDb();
  return db
    .select({
      entity: schema.entityMentions.entity,
      count: sql<number>`count(*)`.as("count"),
    })
    .from(schema.entityMentions)
    .groupBy(schema.entityMentions.entity)
    .all()
    .sort((a, b) => b.count - a.count || a.entity.localeCompare(b.entity));
}

/** Do local bars already reach ~5 trading days before the event? */
function barsCoverEvent(bars: Bar[], eventDate: string): boolean {
  if (bars.length === 0) return false;
  const day = eventDate.slice(0, 10);
  let idx = -1;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].date.slice(0, 10) >= day) {
      idx = i;
      break;
    }
  }
  // idx === -1 means the event is after our last local bar (future relative to
  // our data) — backfilling older history won't help, so treat as "covered".
  if (idx === -1) return true;
  return idx >= 5;
}

/**
 * Choose an Alpaca `limit` large enough that the derived `start` date reaches
 * before the event (for the 5-day pre-window) and the series extends through the
 * +20-day post-window. getHistoricalBars uses start = now − limit×1.5 days.
 */
function backfillLimit(eventDate: string): number {
  const daysSinceEvent = (Date.now() - new Date(eventDate).getTime()) / 86400000;
  const neededCalendarDays = Math.max(0, daysSinceEvent) + 45; // pre/post window padding
  return Math.min(10000, Math.max(400, Math.ceil(neededCalendarDays / 1.5) + 30));
}

/** Return bars for `ticker` that cover the event window, backfilling if needed. */
async function ensureBarsCover(
  ticker: string,
  eventDate: string,
  alpaca: AlpacaService | null,
): Promise<Bar[]> {
  let bars = getBars(ticker);
  if (barsCoverEvent(bars, eventDate)) return bars;
  if (!alpaca) return bars; // best effort without credentials
  const fetched = await alpaca
    .getHistoricalBars(ticker, "1Day", backfillLimit(eventDate))
    .catch(() => [] as Bar[]);
  if (fetched.length > 0) {
    saveBars(ticker, fetched); // persist so future runs are fast
    bars = getBars(ticker); // re-read merged old+new
  }
  return bars;
}

export interface EntityEventDetail {
  id: number;
  ticker: string;
  claim: string | null;
  direction: string;
  eventDate: string;
  resolvedEventDate: string;
  windows: EventStudyResult["windows"];
}

export interface EntityAnalysis {
  entity: string;
  totalMentions: number;
  analyzed: number;
  summary: EntityEdgeSummary;
  perEvent: EntityEventDetail[];
  skipped: { id: number; ticker: string; eventDate: string; reason: string }[];
}

/**
 * Pool every mention by `entity` into a before/after abnormal-return edge.
 * Backfills bars for old event dates on demand and benchmarks against SPY.
 */
export async function analyzeEntity(entity: string): Promise<EntityAnalysis> {
  const mentions = listMentions({ entity });
  const empty: EntityAnalysis = {
    entity,
    totalMentions: mentions.length,
    analyzed: 0,
    summary: aggregateEventStudies([]),
    perEvent: [],
    skipped: [],
  };
  if (mentions.length === 0) return empty;

  const alpaca = AlpacaService.fromEnv();

  // SPY benchmark: fetch once, covering the earliest event among the mentions.
  const earliest = mentions.reduce(
    (min, m) => (m.eventDate < min ? m.eventDate : min),
    mentions[0].eventDate,
  );
  const spyBars = await ensureBarsCover("SPY", earliest, alpaca);

  const results: EventStudyResult[] = [];
  const perEvent: EntityEventDetail[] = [];
  const skipped: EntityAnalysis["skipped"] = [];

  for (const m of mentions) {
    try {
      const bars = await ensureBarsCover(m.ticker, m.eventDate, alpaca);
      const result = eventStudy(bars, spyBars, m.eventDate);
      if (!result) {
        skipped.push({
          id: m.id,
          ticker: m.ticker,
          eventDate: m.eventDate,
          reason:
            bars.length === 0
              ? "no price history available for this ticker"
              : "price bars don't cover the event window",
        });
        continue;
      }
      results.push(result);
      perEvent.push({
        id: m.id,
        ticker: m.ticker,
        claim: m.claim,
        direction: m.direction,
        eventDate: m.eventDate,
        resolvedEventDate: result.resolvedEventDate,
        windows: result.windows,
      });
    } catch (e) {
      skipped.push({
        id: m.id,
        ticker: m.ticker,
        eventDate: m.eventDate,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return {
    entity,
    totalMentions: mentions.length,
    analyzed: results.length,
    summary: aggregateEventStudies(results),
    perEvent,
    skipped,
  };
}
