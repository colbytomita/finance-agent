import { and, desc, eq, like } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { loadConfig } from "@/lib/config";
import type { Confidence, ImpactDirection } from "@/lib/types";
import { isCatalystStale } from "./catalysts";
import { analyzeEntity, distinctEntities, type MentionDirection } from "./entityMentions";
import type { EntityEdgeSummary, EventWindowKey } from "./eventStudy";
import { getTrackedTickers, recomputeStockAnalysis } from "./marketData";

// Phase 3 — close the loop. Turn a measured entity edge (from analyzeEntity)
// into catalysts that feed the existing scoring engine. Because edge catalysts
// live in the `catalysts` table, they flow through getCatalystInputs → scoreStock
// (catalyst + sentiment + risk components) and show up in the catalysts view and
// on stock pages automatically. Everything stays interpretable and labelled as
// historical correlation, never a prediction.

export const EDGE_SOURCE = "catalyst-edge";
const PRIMARY_WINDOW: EventWindowKey = "post5"; // the [0,+5] trading-day window
const DEFAULT_MIN_SAMPLES = 3;
const IMPACT_SCALE = 1.0; // ~1 impact point per 1% mean abnormal return
const MIN_ABS_IMPACT = 0.5; // below this we don't bother creating a catalyst

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export interface EdgeImpact {
  impactScore: number; // -5..+5 (1 decimal)
  confidence: Confidence;
  n: number;
  hitRate: number | null;
  meanAbnormalReturnPct: number;
  window: EventWindowKey;
}

/**
 * Map an entity's pooled edge + a mention's stated direction to a catalyst
 * impact. Returns null when there's too little evidence (n < minSamples) or the
 * effect is negligible. Pure and interpretable:
 *   - magnitude follows the measured mean abnormal 5-day return,
 *   - if the mention's stated direction contradicts the measured tendency the
 *     magnitude is halved (a mixed signal),
 *   - confidence scales with the sample size n.
 */
export function edgeImpact(
  summary: EntityEdgeSummary,
  direction: MentionDirection,
  opts: { minSamples?: number } = {},
): EdgeImpact | null {
  const minSamples = opts.minSamples ?? DEFAULT_MIN_SAMPLES;
  const w = summary.windows.find((x) => x.key === PRIMARY_WINDOW);
  if (!w || w.meanAbnormalReturnPct == null || w.n < minSamples) return null;

  const base = w.meanAbnormalReturnPct;
  let impact = clamp(base * IMPACT_SCALE, -5, 5);

  const mentionSign = direction === "bullish" ? 1 : direction === "bearish" ? -1 : 0;
  if (mentionSign !== 0 && Math.sign(base) !== 0 && mentionSign !== Math.sign(base)) {
    impact *= 0.5; // stated direction contradicts the measured tendency
  }
  impact = Math.round(impact * 10) / 10;
  if (Math.abs(impact) < MIN_ABS_IMPACT) return null;

  const confidence: Confidence = w.n >= 8 ? "high" : w.n >= 4 ? "medium" : "low";
  return {
    impactScore: impact,
    confidence,
    n: w.n,
    hitRate: w.hitRate,
    meanAbnormalReturnPct: base,
    window: PRIMARY_WINDOW,
  };
}

/** Human-readable catalyst title + summary (carries sample size + caveat). */
export function describeEdge(
  entity: string,
  ticker: string,
  direction: MentionDirection,
  edge: EdgeImpact,
): { title: string; summary: string } {
  const hr = edge.hitRate != null ? `${edge.hitRate.toFixed(0)}% hit rate` : "hit rate n/a";
  const sign = edge.meanAbnormalReturnPct >= 0 ? "+" : "";
  return {
    title: `${entity} mentioned ${ticker} (${direction})`,
    summary:
      `Historical edge: after ${entity} mentioned a stock, the 5-day market-adjusted return averaged ` +
      `${sign}${edge.meanAbnormalReturnPct.toFixed(2)}% (${hr}, n=${edge.n}). ` +
      `Mapped to impact ${edge.impactScore >= 0 ? "+" : ""}${edge.impactScore}, confidence ${edge.confidence}. ` +
      `Historical correlation across a small sample — not advice or a prediction.`,
  };
}

function mentionToImpactDirection(impact: number): ImpactDirection {
  return impact > 0 ? "positive" : impact < 0 ? "negative" : "mixed";
}

/** Tag marker so edge catalysts for a given entity can be found/replaced. */
function edgeTags(entity: string): string {
  // entity goes LAST with a leading comma so a suffix LIKE is collision-safe.
  return `${EDGE_SOURCE},win:${PRIMARY_WINDOW},entity:${entity}`;
}

/** Is this mention recent enough to become a current scoring catalyst? */
export function isFreshEdgeMention(
  eventDate: string,
  freshnessDays: number,
  now: number = Date.now(),
): boolean {
  return !isCatalystStale({ eventDate, discoveredAt: eventDate }, freshnessDays, now);
}

/** Current persisted edge catalysts for a ticker (for stock page / agent rationale). */
export function edgeCatalystsForTicker(ticker: string) {
  const cfg = loadConfig();
  const now = Date.now();
  return getDb()
    .select()
    .from(schema.catalysts)
    .where(and(eq(schema.catalysts.ticker, ticker.toUpperCase()), eq(schema.catalysts.sourceName, EDGE_SOURCE)))
    .orderBy(desc(schema.catalysts.discoveredAt))
    .limit(20)
    .all()
    .filter((c) => c.status !== "expired" && !isCatalystStale(c, cfg.catalystFreshnessDays, now));
}

function deleteEdgeCatalystsForEntity(entity: string): void {
  getDb()
    .delete(schema.catalysts)
    .where(and(eq(schema.catalysts.sourceName, EDGE_SOURCE), like(schema.catalysts.tags, `%,entity:${entity}`)))
    .run();
}

function writeEdgeCatalyst(input: {
  entity: string;
  ticker: string;
  title: string;
  summary: string;
  impact: number;
  confidence: Confidence;
  eventDate: string;
}): void {
  const db = getDb();
  const affectsActiveTrade = db
    .select({ status: schema.activeTrades.status })
    .from(schema.activeTrades)
    .where(eq(schema.activeTrades.ticker, input.ticker))
    .all()
    .some((t) => t.status === "open");

  db.insert(schema.catalysts)
    .values({
      ticker: input.ticker,
      industry: null,
      title: input.title,
      summary: input.summary,
      sourceUrl: null,
      sourceName: EDGE_SOURCE,
      catalystType: "entity_mention",
      eventDate: input.eventDate,
      discoveredAt: new Date().toISOString(),
      impactDirection: mentionToImpactDirection(input.impact),
      impactScore: input.impact,
      confidence: input.confidence,
      status: "occurred",
      tags: edgeTags(input.entity),
      affectsActiveTrade,
    })
    .run();
}

export interface ApplyEdgeResult {
  entitiesProcessed: number;
  catalystsWritten: number;
  tickersRecomputed: number;
  skipped: number;
  details: { entity: string; ticker: string; impact: number; n: number }[];
}

/**
 * For each entity (or one given entity), compute its pooled edge and write one
 * edge catalyst per ticker it has mentioned (latest mention's direction/date),
 * then recompute scores for any affected tracked tickers so the edge shows up in
 * the blended score immediately.
 */
export async function applyEntityEdge(
  opts: { entity?: string; minSamples?: number; recompute?: boolean } = {},
): Promise<ApplyEdgeResult> {
  const entities = opts.entity ? [opts.entity] : distinctEntities().map((e) => e.entity);
  const cfg = loadConfig();
  const now = Date.now();
  const result: ApplyEdgeResult = {
    entitiesProcessed: 0,
    catalystsWritten: 0,
    tickersRecomputed: 0,
    skipped: 0,
    details: [],
  };
  const affected = new Set<string>();

  for (const entity of entities) {
    const analysis = await analyzeEntity(entity);
    result.entitiesProcessed++;
    if (analysis.analyzed === 0) continue;

    // Latest mention per ticker for this entity.
    const latestByTicker = new Map<string, (typeof analysis.perEvent)[number]>();
    for (const ev of analysis.perEvent) {
      const cur = latestByTicker.get(ev.ticker);
      if (!cur || ev.eventDate > cur.eventDate) latestByTicker.set(ev.ticker, ev);
    }

    // Replace this entity's prior edge catalysts so re-runs stay idempotent.
    deleteEdgeCatalystsForEntity(entity);

    for (const [ticker, ev] of latestByTicker) {
      if (!isFreshEdgeMention(ev.eventDate, cfg.catalystFreshnessDays, now)) {
        result.skipped++;
        continue;
      }
      const edge = edgeImpact(analysis.summary, ev.direction as MentionDirection, {
        minSamples: opts.minSamples,
      });
      if (!edge) {
        result.skipped++;
        continue;
      }
      const { title, summary } = describeEdge(entity, ticker, ev.direction as MentionDirection, edge);
      writeEdgeCatalyst({
        entity,
        ticker,
        title,
        summary,
        impact: edge.impactScore,
        confidence: edge.confidence,
        eventDate: ev.eventDate,
      });
      result.catalystsWritten++;
      result.details.push({ entity, ticker, impact: edge.impactScore, n: edge.n });
      affected.add(ticker);
    }
  }

  // Recompute scores for affected tracked tickers (default on).
  if (opts.recompute !== false && affected.size > 0) {
    const tracked = new Set(getTrackedTickers());
    for (const ticker of affected) {
      if (!tracked.has(ticker)) continue;
      try {
        recomputeStockAnalysis(ticker);
        result.tickersRecomputed++;
      } catch {
        // best effort — scoring will catch up on the next refresh
      }
    }
  }

  return result;
}
