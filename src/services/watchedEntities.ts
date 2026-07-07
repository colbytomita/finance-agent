import { sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { nowIso } from "@/lib/util";
import { emitAlert } from "./alerts";

// Watched entities (roadmap #24): star a Catalyst-Edge entity to get an in-app
// alert (and, per the notification settings, a push) when event ingestion finds
// new mentions of it — so "someone you care about said something new" surfaces
// without opening the Events page. Matching is case-insensitive.

const norm = (s: string) => s.trim();

export function watchEntity(entity: string): void {
  const e = norm(entity);
  if (!e) return;
  getDb()
    .insert(schema.watchedEntities)
    .values({ entity: e, createdAt: nowIso() })
    .onConflictDoNothing()
    .run();
}

export function unwatchEntity(entity: string): void {
  const e = norm(entity).toLowerCase();
  getDb()
    .delete(schema.watchedEntities)
    .where(sql`lower(${schema.watchedEntities.entity}) = ${e}`)
    .run();
}

export function listWatchedEntities(): string[] {
  return getDb().select().from(schema.watchedEntities).all().map((r) => r.entity);
}

export function isEntityWatched(entity: string): boolean {
  const e = norm(entity).toLowerCase();
  return listWatchedEntities().some((w) => w.toLowerCase() === e);
}

/** New mentions found for one entity during an ingestion run. */
export interface EntityMentionBatch {
  count: number;
  tickers: Set<string>;
}

/**
 * Emit one info-severity alert per watched entity that got new mentions this run
 * (e.g. "Elon Musk: 2 new mentions — DJT, TSLA"). emitAlert de-dupes by
 * type+message within 20h, so an identical re-run doesn't spam. Returns how many
 * alerts were actually emitted.
 */
export function alertWatchedEntities(newByEntity: Map<string, EntityMentionBatch>): number {
  if (newByEntity.size === 0) return 0;
  const watched = new Set(listWatchedEntities().map((w) => w.toLowerCase()));
  if (watched.size === 0) return 0;
  let emitted = 0;
  for (const [entity, batch] of newByEntity) {
    if (!watched.has(norm(entity).toLowerCase())) continue;
    const tickers = [...batch.tickers].sort();
    const msg = `${entity}: ${batch.count} new mention${batch.count === 1 ? "" : "s"} — ${tickers.join(", ")}`;
    if (emitAlert("watched_entity", "info", msg, tickers[0] ?? null)) emitted++;
  }
  return emitted;
}
