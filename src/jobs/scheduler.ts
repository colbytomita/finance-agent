// Standalone background-job runner: `npm run jobs`
// Market-state-aware refresh cadence + daily catalyst maintenance.
// Runs alongside `npm run dev`/`start` and shares the same SQLite database.

import cron from "node-cron";
import { loadConfig } from "@/lib/config";
import {
  fullRefresh,
  refreshPrices,
  recomputeStockAnalysis,
  recomputeTradeScores,
  getTrackedTickers,
  syncPortfolio,
} from "@/services/marketData";
import { generateAlerts } from "@/services/alerts";
import { rollCatalystStatuses, scanYahooNews } from "@/services/catalysts";
import { AlpacaService } from "@/services/alpaca";
import { runDiscoveryScan } from "@/services/discoveryAgent";

const log = (msg: string) => console.log(`[jobs ${new Date().toISOString()}] ${msg}`);

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
    for (const t of getTrackedTickers()) {
      try {
        recomputeStockAnalysis(t);
      } catch (e) {
        log(`score ${t} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    recomputeTradeScores();
    const alerts = generateAlerts();
    lastRefresh = Date.now();
    const failed = prices.filter((p) => !p.ok);
    log(
      `refresh done: ${prices.length - failed.length}/${prices.length} tickers ok, ${alerts} new alert(s)` +
        (failed.length > 0 ? ` — failed: ${failed.map((f) => f.ticker).join(", ")}` : ""),
    );
  } catch (e) {
    log(`refresh failed: ${e instanceof Error ? e.message : e}`);
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
    if (cfg.yahooBrowserEnabled) {
      const added = await scanYahooNews(getTrackedTickers()).catch((e) => {
        log(`news scan failed: ${e instanceof Error ? e.message : e}`);
        return 0;
      });
      log(`news scan added ${added} catalyst(s)`);
    }
    const picks = await runDiscoveryScan().catch((e) => {
      log(`discovery scan failed: ${e instanceof Error ? e.message : e}`);
      return null;
    });
    if (picks) log(`discovery scan: ${picks.proposed} new pick(s) from ${picks.scanned} scanned`);
    generateAlerts();
    log("daily maintenance done");
  } catch (e) {
    log(`daily maintenance failed: ${e instanceof Error ? e.message : e}`);
  }
}

async function catalystScan(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.yahooBrowserEnabled) return;
  log("catalyst scan start");
  const added = await scanYahooNews(getTrackedTickers()).catch(() => 0);
  rollCatalystStatuses();
  generateAlerts();
  log(`catalyst scan done: ${added} new`);
}

log("scheduler starting — Ctrl+C to stop");
log(`tracked tickers: ${getTrackedTickers().join(", ") || "(none yet)"}`);

// Tick every minute; maybeRefresh applies the phase-appropriate interval.
cron.schedule("* * * * *", () => void maybeRefresh());
// Catalyst scan every 4 hours on weekdays.
cron.schedule("0 */4 * * 1-5", () => void catalystScan());
// Daily maintenance at 8:00 local time (bars, setups, portfolio sync, news).
cron.schedule("0 8 * * *", () => void dailyMaintenance());

// Kick off an initial refresh immediately.
void maybeRefresh();
