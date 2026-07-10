// Standalone background-job runner: `npm run jobs`
// Market-state-aware refresh cadence + daily catalyst maintenance.
// Runs alongside `npm run dev`/`start` and shares the same SQLite database.

import cron from "node-cron";
import { loadDotEnv } from "@/lib/loadEnv";
// Plain tsx doesn't load .env like Next does (roadmap #40) — without this the
// scheduler ran keyless: Yahoo-only quotes, no broker order sync, no LLM.
// Every env read in the codebase happens at call time, so loading here —
// before any job runs — is early enough.
loadDotEnv();
import { loadConfig } from "@/lib/config";
import { errorMessage, nowIso } from "@/lib/util";
import {
  fullRefresh,
  recomputeStockAnalysis,
  recomputeTradeScores,
  getTrackedTickers,
  syncPortfolio,
} from "@/services/marketData";
import { refreshPrices } from "@/services/quotes";
import { upsertPortfolioSnapshot } from "@/services/portfolioHistory";
import { generateAlerts } from "@/services/alerts";
import { syncBrokerOrders } from "@/services/orderSync";
import { rollCatalystStatuses, scanYahooNews } from "@/services/catalysts";
import { AlpacaService } from "@/services/alpaca";
import { runDiscoveryScan } from "@/services/discoveryAgent";
import { runSectorScan } from "@/services/sectorScout";
import { runEventIngestion } from "@/services/eventIngestion";
import { backfillCompanyNames } from "@/services/companyNames";
import { backfillHoldingSectors } from "@/services/sectors";
import { sendMorningBrief } from "@/services/morningBrief";
import { applyEntityEdge } from "@/services/catalystEdge";
import { fetchEarningsForTickers, fetchUpcomingEarningsForTickers } from "@/services/earnings";
import { runPerformanceBacktest } from "@/services/signalPerformance";
import { runRetention, runSqliteHousekeeping } from "@/services/retention";
import { recordJobRun, getJobHealth, isDailyJobDue } from "@/services/jobHealth";
import { integrationsStatus } from "@/services/integrations";
import { runBackup } from "@/services/backup";

const log = (msg: string) => console.log(`[jobs ${nowIso()}] ${msg}`);

type MarketPhase = "open" | "extended" | "closed";

async function detectPhase(): Promise<MarketPhase> {
  const alpaca = AlpacaService.fromEnv();
  if (!alpaca) {
    // Approximate from US/Eastern wall-clock when Alpaca is unavailable.
    const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
    const day = et.getDay();
    if (day === 0 || day === 6) return "closed";
    const mins = et.getHours() * 60 + et.getMinutes();
    if (mins >= 570 && mins < 960) return "open"; // 9:30–16:00
    if ((mins >= 240 && mins < 570) || (mins >= 960 && mins < 1200)) return "extended"; // 4:00–9:30, 16:00–20:00
    return "closed";
  }
  try {
    const clock = await alpaca.getMarketClock();
    if (clock.isOpen) return "open";
    // Within 5.5h before open or 4h after close => extended hours window.
    const now = Date.now();
    const nextOpen = clock.nextOpen ? new Date(clock.nextOpen).getTime() : null;
    if (nextOpen != null && nextOpen - now < 5.5 * 3600 * 1000) return "extended";
    return "closed";
  } catch {
    return "closed";
  }
}

let refreshing = false;
let lastRefresh = 0;

async function maybeRefresh(): Promise<void> {
  if (refreshing) return;
  const cfg = loadConfig();
  const phase = await detectPhase();
  const interval =
    phase === "open"
      ? cfg.refreshIntervalMarketOpenSec
      : phase === "extended"
        ? cfg.refreshIntervalExtendedHoursSec
        : cfg.refreshIntervalClosedSec;
  if (Date.now() - lastRefresh < interval * 1000) return;

  refreshing = true;
  try {
    log(`refresh start (market ${phase})`);
    const prices = await refreshPrices();
    upsertPortfolioSnapshot(); // keep today's account-value row current (roadmap #31)
    // Reconcile broker orders before recomputing trade scores so corrections
    // (actual fill price/size, canceled phantom trades) feed this cycle.
    const orders = await syncBrokerOrders().catch((e) => {
      log(`order sync failed: ${errorMessage(e)}`);
      return null;
    });
    if (
      orders &&
      (orders.corrected || orders.canceled || orders.closed || orders.flagged || orders.errors.length)
    ) {
      log(
        `order sync: ${orders.checked} checked, ${orders.corrected} corrected, ` +
          `${orders.canceled} canceled, ${orders.closed} auto-closed, ${orders.flagged} flagged` +
          (orders.errors.length ? `, ${orders.errors.length} error(s)` : ""),
      );
    }
    for (const t of getTrackedTickers()) {
      try {
        recomputeStockAnalysis(t);
      } catch (e) {
        log(`score ${t} failed: ${errorMessage(e)}`);
      }
    }
    recomputeTradeScores();
    const alerts = generateAlerts();
    lastRefresh = Date.now();
    const failed = prices.filter((p) => !p.ok);
    log(
      `refresh done: ${prices.length - failed.length}/${prices.length} tickers ok, ${alerts} new alert(s)` +
        (failed.length > 0 ? ` — failed: ${failed.map((f) => f.ticker).join(", ")}` : "") +
        // Sample one failure reason so transient source blips (rate limits,
        // outages) are diagnosable from the log alone.
        (failed[0]?.error ? ` — e.g. ${failed[0].ticker}: ${failed[0].error}` : ""),
    );
    recordJobRun("refresh");
  } catch (e) {
    log(`refresh failed: ${errorMessage(e)}`);
    recordJobRun("refresh", "error", errorMessage(e));
  } finally {
    refreshing = false;
  }
}

async function dailyMaintenance(): Promise<void> {
  log("daily maintenance start");
  try {
    rollCatalystStatuses();
    const sync = await syncPortfolio();
    log("error" in sync ? `portfolio sync skipped: ${sync.error}` : `portfolio synced: ${sync.synced}`);
    await fullRefresh(); // includes bars + setups
    const cfg = loadConfig();
    if (cfg.yahooEnabled) {
      const added = await scanYahooNews(getTrackedTickers()).catch((e) => {
        log(`news scan failed: ${errorMessage(e)}`);
        return 0;
      });
      log(`news scan added ${added} catalyst(s)`);
    }
    const picks = await runDiscoveryScan().catch((e) => {
      log(`discovery scan failed: ${errorMessage(e)}`);
      return null;
    });
    if (picks) log(`discovery scan: ${picks.proposed} new pick(s) from ${picks.scanned} scanned`);

    // Sector Scout: re-scan each favorite industry so its picks stay fresh.
    if (cfg.sectorScoutScanEnabled && cfg.sectorScoutIndustries.length > 0) {
      for (const industry of cfg.sectorScoutIndustries) {
        const res = await runSectorScan({ industry, cfg }).catch((e) => {
          log(`sector scout "${industry}" failed: ${errorMessage(e)}`);
          return null;
        });
        if (res)
          log(
            `sector scout "${res.industry}": ${res.proposed} pick(s) from ${res.scanned} scored (${res.expandedBy})`,
          );
      }
    }

    // Auto-fetch quarterly earnings (estimate vs actual) for tracked tickers, then
    // recompute so a fresh beat/miss weighs into scores. Yahoo HTTP-first with
    // browser fallback, best effort.
    if (cfg.yahooEnabled) {
      const earn = await fetchEarningsForTickers(getTrackedTickers()).catch((e) => {
        log(`earnings fetch failed: ${errorMessage(e)}`);
        return null;
      });
      if (earn) {
        log(
          `earnings: saved ${earn.saved} quarter(s) across ${earn.tickers} ticker(s)` +
            (earn.errors.length ? `, ${earn.errors.length} error(s)` : ""),
        );
        for (const t of getTrackedTickers()) {
          try {
            recomputeStockAnalysis(t);
          } catch {
            /* best effort */
          }
        }
      }

      // Refresh *upcoming* earnings dates so the earnings-proximity guard has
      // data — the fetch above only stores past results. These are schedule
      // markers, kept out of the score blend (see getCatalystInputs).
      const upcoming = await fetchUpcomingEarningsForTickers(getTrackedTickers()).catch((e) => {
        log(`upcoming earnings fetch failed: ${errorMessage(e)}`);
        return null;
      });
      if (upcoming && (upcoming.inserted || upcoming.updated))
        log(
          `upcoming earnings: ${upcoming.inserted} new, ${upcoming.updated} updated ` +
            `across ${upcoming.tickers} ticker(s)`,
        );

      // Fill missing holding sectors (roadmap #37) so sector-concentration
      // warnings and the portfolio breakdown work. Incremental — only rows
      // without a sector are fetched.
      const sectors = await backfillHoldingSectors().catch((e) => {
        log(`sector backfill failed: ${errorMessage(e)}`);
        return null;
      });
      if (sectors && sectors.filled > 0)
        log(`sector backfill: filled ${sectors.filled}/${sectors.checked} holding(s)`);
    }
    // Backfill missing company names (SEC ticker->name) so the UI and GDELT
    // auto-queries have real names to work with. Cheap; the SEC file is cached.
    const names = await backfillCompanyNames().catch((e) => {
      log(`name backfill failed: ${errorMessage(e)}`);
      return null;
    });
    if (names && names.resolved > 0)
      log(`name backfill: filled ${names.resolved}/${names.scanned} missing name(s)`);

    if (cfg.eventIngestionEnabled) {
      const ing = await runEventIngestion({ trigger: "scheduled" }).catch((e) => {
        log(`event ingestion failed: ${errorMessage(e)}`);
        return null;
      });
      if (ing)
        log(
          `event ingestion: ${ing.persisted} new mention(s) from ${ing.fetched} item(s) (${ing.generatedBy})`,
        );
      // Feed the measured entity edge back into scoring as catalysts.
      const edge = await applyEntityEdge().catch((e) => {
        log(`apply entity edge failed: ${errorMessage(e)}`);
        return null;
      });
      if (edge)
        log(
          `entity edge: ${edge.catalystsWritten} catalyst(s), ${edge.tickersRecomputed} score(s) recomputed`,
        );
    }
    // Prune append-only tables (snapshots, drawdowns, score history) and thin
    // old stock scores so the DB doesn't grow unbounded at refresh cadence.
    try {
      const ret = runRetention();
      const total =
        ret.snapshotsDeleted +
        ret.drawdownsDeleted +
        ret.scoreHistoryDeleted +
        ret.scoresThinned +
        ret.alertsAutoAcked +
        ret.alertsDeleted +
        ret.setupsThinned;
      if (total > 0)
        log(
          `retention: pruned ${ret.snapshotsDeleted} snapshot(s), ${ret.drawdownsDeleted} drawdown(s), ` +
            `${ret.scoreHistoryDeleted} score change(s), thinned ${ret.scoresThinned} score(s) + ` +
            `${ret.setupsThinned} setup(s), auto-acked ${ret.alertsAutoAcked} stale alert(s), ` +
            `deleted ${ret.alertsDeleted} old acked alert(s)`,
        );
    } catch (e) {
      log(`retention failed: ${errorMessage(e)}`);
    }
    // SQLite upkeep after pruning: refresh planner stats and flush/truncate the
    // WAL so it doesn't grow unbounded between backups.
    try {
      const hk = runSqliteHousekeeping();
      log(
        `sqlite housekeeping: optimize ${hk.optimized ? "ok" : "skipped"}, ` +
          `wal checkpoint ${hk.walCheckpointed ? "ok" : "busy"}` +
          (hk.walPages != null ? ` (${hk.walPages} page(s))` : ""),
      );
    } catch (e) {
      log(`sqlite housekeeping failed: ${errorMessage(e)}`);
    }
    // Refresh the Signal Performance report so the Sector Scout industry
    // strip reads today's picks/scores instead of a stale manual run.
    const perf = await runPerformanceBacktest().catch((e) => {
      log(`performance backtest failed: ${errorMessage(e)}`);
      return null;
    });
    if (perf)
      log(
        `performance backtest: ${perf.score.analyzed} score event(s), ${perf.picks.analyzed} pick event(s) analyzed`,
      );
    generateAlerts();
    // Opt-in morning brief (roadmap #39) — after the refresh and alert scan
    // so it summarizes today's state. Idempotent per day.
    const brief = await sendMorningBrief().catch((e) => {
      log(`morning brief failed: ${errorMessage(e)}`);
      return null;
    });
    if (brief && brief.reason !== "disabled") log(`morning brief: ${brief.reason}`);
    // Last: snapshot the day's final state to data/backups (keeps last 7).
    try {
      const b = runBackup();
      if (b.created)
        log(`backup written: ${b.path} (${(b.bytes / 1024 / 1024).toFixed(1)} MB)` +
          (b.pruned.length ? `, pruned ${b.pruned.length} old` : ""));
    } catch (e) {
      log(`backup failed: ${errorMessage(e)}`);
    }
    recordJobRun("daily_maintenance");
    log("daily maintenance done");
  } catch (e) {
    log(`daily maintenance failed: ${errorMessage(e)}`);
    recordJobRun("daily_maintenance", "error", errorMessage(e));
  }
}

async function catalystScan(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.yahooEnabled) return;
  log("catalyst scan start");
  const added = await scanYahooNews(getTrackedTickers()).catch(() => 0);
  rollCatalystStatuses();
  generateAlerts();
  recordJobRun("catalyst_scan");
  log(`catalyst scan done: ${added} new`);
}

log("scheduler starting — Ctrl+C to stop");
log(`tracked tickers: ${getTrackedTickers().join(", ") || "(none yet)"}`);

// Poll ~every minute; maybeRefresh self-throttles to the phase interval.
// A self-scheduling timer (not cron) avoids node-cron's "missed execution"
// warnings when the machine sleeps between ticks — on wake it just fires once
// and reschedules, instead of flushing one warning per skipped minute.
async function refreshLoop(): Promise<void> {
  try {
    // Liveness signal for the UI: ticks every minute even when the refresh
    // itself is skipped, so a stale heartbeat means the runner is down. The
    // message reports THIS process's integrations (roadmap #41) — the web
    // process can have .env while the runner doesn't (see roadmap #40), and
    // /status flags that mismatch from this string.
    const integ = integrationsStatus();
    recordJobRun(
      "heartbeat",
      "ok",
      `alpaca=${integ.alpacaConfigured ? integ.alpacaMode : "off"} llm=${integ.llmConfigured ? "on" : "off"}`,
    );
    await maybeRefresh();
  } finally {
    setTimeout(() => void refreshLoop(), 60_000);
  }
}

// Catalyst scan every 4 hours on weekdays.
cron.schedule("0 */4 * * 1-5", () => void catalystScan());
// Daily maintenance at 8:00 local time (bars, setups, portfolio sync, news).
cron.schedule("0 8 * * *", () => void dailyMaintenance());

// Startup catch-up (roadmap #43): the 08:00 cron only fires while the runner
// is alive at 08:00 — an ad-hoc terminal runner misses it routinely, which is
// how zero daily_maintenance runs (and zero backups) accumulated. If the last
// completed maintenance is missing or >20h old, run it shortly after boot.
{
  const lastMaint = getJobHealth().jobs.find((j) => j.job === "daily_maintenance")?.lastRunAt;
  if (isDailyJobDue(lastMaint)) {
    log(
      lastMaint
        ? `daily maintenance last ran ${lastMaint} — catch-up run in 30s`
        : "daily maintenance has never completed — catch-up run in 30s",
    );
    setTimeout(() => void dailyMaintenance(), 30_000);
  }
}

// Kick off the refresh loop immediately.
void refreshLoop();
