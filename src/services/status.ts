import fs from "node:fs";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { getJobHealth, type JobHealth } from "./jobHealth";
import { integrationsStatus, type IntegrationsStatus } from "./integrations";
import { listBackups, dbPath } from "./backup";
import { getTrackedTickers } from "./marketData";

// Data collection for the /status page (roadmap #13): integrations health,
// job heartbeats, database size/row counts, per-ticker bar coverage, backups.

export interface BarCoverage {
  ticker: string;
  bars: number;
  firstDay: string | null;
  lastDay: string | null;
  tracked: boolean;
}

export interface StatusReport {
  integrations: IntegrationsStatus & {
    yahooEnabled: boolean;
    yahooBrowserFallback: boolean; // env YAHOO_BROWSER_ENABLED gates the browser layer
  };
  jobs: JobHealth;
  db: {
    path: string;
    bytes: number;
    tables: { name: string; rows: number }[];
  };
  barCoverage: BarCoverage[];
  backups: { file: string; bytes: number; modifiedAt: string }[];
}

export function getStatusReport(yahooEnabled: boolean): StatusReport {
  const db = getDb();

  const tableNames = (
    db.all(
      sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    ) as { name: string }[]
  ).map((r) => r.name);
  const tables = tableNames.map((name) => ({
    name,
    rows: (db.get(sql.raw(`SELECT COUNT(*) AS n FROM "${name}"`)) as { n: number }).n,
  }));

  const tracked = new Set(getTrackedTickers());
  const coverageRows = db.all(
    sql`SELECT ticker, COUNT(*) AS n, MIN(bar_date) AS first_day, MAX(bar_date) AS last_day
        FROM price_bars GROUP BY ticker ORDER BY ticker`,
  ) as { ticker: string; n: number; first_day: string | null; last_day: string | null }[];
  const covered = new Set(coverageRows.map((r) => r.ticker));
  const barCoverage: BarCoverage[] = [
    ...coverageRows.map((r) => ({
      ticker: r.ticker,
      bars: r.n,
      firstDay: r.first_day,
      lastDay: r.last_day,
      tracked: tracked.has(r.ticker),
    })),
    // Tracked tickers with no bars at all are the interesting gaps — show them.
    ...[...tracked]
      .filter((t) => !covered.has(t))
      .map((ticker) => ({ ticker, bars: 0, firstDay: null, lastDay: null, tracked: true })),
  ].sort((a, b) => a.ticker.localeCompare(b.ticker));

  const p = dbPath();
  return {
    integrations: {
      ...integrationsStatus(),
      yahooEnabled,
      // Same default as YahooFinanceBrowserService: on unless explicitly "false".
      yahooBrowserFallback: process.env.YAHOO_BROWSER_ENABLED !== "false",
    },
    jobs: getJobHealth(),
    db: { path: p, bytes: fs.existsSync(p) ? fs.statSync(p).size : 0, tables },
    barCoverage,
    backups: listBackups(),
  };
}
