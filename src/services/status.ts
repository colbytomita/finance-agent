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
    walBytes: number; // size of the -wal sidecar (checkpointed nightly)
    tables: { name: string; rows: number }[];
  };
  barCoverage: BarCoverage[];
  backups: { file: string; bytes: number; modifiedAt: string }[];
  schedulerEnv: SchedulerEnv;
}

export interface SchedulerEnv {
  /** The runner-reported integration string from its heartbeat, if any. */
  reported: string | null;
  /** Web process has Alpaca but the runner reports alpaca=off (roadmap #40's failure mode). */
  alpacaMismatch: boolean;
}

/**
 * Compare the job runner's self-reported env (heartbeat message, roadmap
 * #41) against this process's. Pure — the runner is a separate process, so
 * its `.env` situation can differ from the web app's.
 */
export function schedulerEnvFromHeartbeat(
  heartbeatMessage: string | null | undefined,
  webAlpacaConfigured: boolean,
): SchedulerEnv {
  const reported =
    heartbeatMessage && /alpaca=/.test(heartbeatMessage) ? heartbeatMessage : null;
  return {
    reported,
    alpacaMismatch: Boolean(reported && webAlpacaConfigured && /alpaca=off/.test(reported)),
  };
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
  const sizeOf = (f: string) => (fs.existsSync(f) ? fs.statSync(f).size : 0);
  const integrations = integrationsStatus();
  const jobs = getJobHealth();
  return {
    integrations: {
      ...integrations,
      yahooEnabled,
      // Same default as YahooFinanceBrowserService: on unless explicitly "false".
      yahooBrowserFallback: process.env.YAHOO_BROWSER_ENABLED !== "false",
    },
    jobs,
    db: { path: p, bytes: sizeOf(p), walBytes: sizeOf(`${p}-wal`), tables },
    barCoverage,
    backups: listBackups(),
    schedulerEnv: schedulerEnvFromHeartbeat(
      jobs.jobs.find((j) => j.job === "heartbeat")?.message,
      integrations.alpacaConfigured,
    ),
  };
}
