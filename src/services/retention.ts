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

export interface RetentionResult {
  snapshotsDeleted: number;
  drawdownsDeleted: number;
  scoreHistoryDeleted: number;
  scoresThinned: number;
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

  return { snapshotsDeleted, drawdownsDeleted, scoreHistoryDeleted, scoresThinned };
}
