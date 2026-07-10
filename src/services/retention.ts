// Data retention for append-only tables. At the market-open cadence the
// scheduler writes a snapshot + drawdown row per ticker every ~2 minutes, so
// these tables grow by thousands of rows a day. Daily maintenance calls
// runRetention() to prune old rows while preserving everything the app reads:
// each ticker's most recent row always survives (latestSnapshot/latestDrawdown/
// latestScore stay valid even for tickers that stopped refreshing), and
// stock_scores is thinned to one row per ticker/day — never truncated — because
// Signal Performance replays it as its event source.

import { sql } from "drizzle-orm";
import { getDb } from "@/db";

/** Price snapshots: intraday-resolution data is only interesting recently. */
const SNAPSHOT_RETENTION_DAYS = 7;
/** Drawdown metrics: latest row per ticker is what the UI/alerts read. */
const DRAWDOWN_RETENTION_DAYS = 30;
/** Score-change feed: the dashboard shows only recent entries. */
const SCORE_HISTORY_RETENTION_DAYS = 90;
/** Scores older than this are thinned to the last row per ticker per day. */
const SCORE_THIN_AFTER_DAYS = 30;
/**
 * Alerts (roadmap #36): a non-critical alert nobody acknowledged in this many
 * days is no longer actionable — auto-ack it so the unacked feed reflects
 * what's current (critical alerts are never auto-acked; they wait for the
 * user). The row itself survives as audit trail until the retention window.
 */
const ALERT_AUTOACK_DAYS = 14;
/** Acknowledged alerts older than this are deleted. */
const ALERT_RETENTION_DAYS = 90;

export interface RetentionResult {
  snapshotsDeleted: number;
  drawdownsDeleted: number;
  scoreHistoryDeleted: number;
  scoresThinned: number;
  alertsAutoAcked: number;
  alertsDeleted: number;
}

const isoDaysAgo = (days: number) =>
  new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();

/**
 * Delete rows of `table` older than `cutoff`, keeping each ticker's newest row
 * (by max id — inserts are chronological) so latest-row lookups keep working.
 */
function pruneKeepingLatest(table: string, timeCol: string, cutoff: string): number {
  const res = getDb().run(
    sql`DELETE FROM ${sql.raw(table)} WHERE ${sql.raw(timeCol)} < ${cutoff} AND id NOT IN (
      SELECT MAX(id) FROM ${sql.raw(table)} GROUP BY ticker
    )`,
  );
  return Number(res.changes);
}

/** Prune append-only tables; returns per-table deletion counts. */
export function runRetention(): RetentionResult {
  const db = getDb();

  const snapshotsDeleted = pruneKeepingLatest(
    "market_price_snapshots",
    "captured_at",
    isoDaysAgo(SNAPSHOT_RETENTION_DAYS),
  );
  const drawdownsDeleted = pruneKeepingLatest(
    "drawdown_metrics",
    "calculated_at",
    isoDaysAgo(DRAWDOWN_RETENTION_DAYS),
  );

  const historyCutoff = isoDaysAgo(SCORE_HISTORY_RETENTION_DAYS);
  const scoreHistoryDeleted = Number(
    db.run(sql`DELETE FROM score_history WHERE recorded_at < ${historyCutoff}`).changes,
  );

  // Thin (don't truncate) old stock scores: for days past the window keep the
  // last score per ticker per day, which is what buildScoreEvents() samples.
  const thinCutoff = isoDaysAgo(SCORE_THIN_AFTER_DAYS);
  const scoresThinned = Number(
    db.run(
      sql`DELETE FROM stock_scores WHERE calculated_at < ${thinCutoff} AND id NOT IN (
        SELECT MAX(id) FROM stock_scores GROUP BY ticker, substr(calculated_at, 1, 10)
      )`,
    ).changes,
  );

  // Alerts (roadmap #36): auto-ack stale non-critical noise, then prune the
  // acknowledged history past the retention window.
  const autoAckCutoff = isoDaysAgo(ALERT_AUTOACK_DAYS);
  const alertsAutoAcked = Number(
    db.run(
      sql`UPDATE alerts SET acknowledged = 1
          WHERE acknowledged = 0 AND severity != 'critical' AND created_at < ${autoAckCutoff}`,
    ).changes,
  );
  const alertDeleteCutoff = isoDaysAgo(ALERT_RETENTION_DAYS);
  const alertsDeleted = Number(
    db.run(
      sql`DELETE FROM alerts WHERE acknowledged = 1 AND created_at < ${alertDeleteCutoff}`,
    ).changes,
  );

  return {
    snapshotsDeleted,
    drawdownsDeleted,
    scoreHistoryDeleted,
    scoresThinned,
    alertsAutoAcked,
    alertsDeleted,
  };
}

export interface HousekeepingResult {
  optimized: boolean;
  walCheckpointed: boolean;
  walPages: number | null; // pages that were in the WAL before the checkpoint
  walPagesCheckpointed: number | null;
}

/**
 * SQLite upkeep run after pruning (roadmap #20). `PRAGMA optimize` refreshes the
 * query planner's statistics; `wal_checkpoint(TRUNCATE)` flushes the write-ahead
 * log into the main database and shrinks the `-wal` file, which otherwise grows
 * unbounded between backups at the refresh cadence. Best effort — never throws,
 * and no-ops harmlessly on a non-WAL (in-memory) database.
 */
export function runSqliteHousekeeping(): HousekeepingResult {
  const db = getDb();
  let optimized = false;
  try {
    db.run(sql`PRAGMA optimize`);
    optimized = true;
  } catch {
    /* best effort */
  }
  let walCheckpointed = false;
  let walPages: number | null = null;
  let walPagesCheckpointed: number | null = null;
  try {
    // Returns one row: busy (0 = fully checkpointed), log (pages in the WAL),
    // checkpointed (pages moved into the main db).
    const row = db.get(sql`PRAGMA wal_checkpoint(TRUNCATE)`) as
      | { busy?: number; log?: number; checkpointed?: number }
      | undefined;
    if (row) {
      walCheckpointed = (row.busy ?? 1) === 0;
      walPages = row.log ?? null;
      walPagesCheckpointed = row.checkpointed ?? null;
    }
  } catch {
    /* best effort — e.g. a non-WAL in-memory database */
  }
  return { optimized, walCheckpointed, walPages, walPagesCheckpointed };
}
