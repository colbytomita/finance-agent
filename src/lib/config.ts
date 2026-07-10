import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { nowIso } from "./util";
import type { Confidence, RiskProfile } from "./types";

// Non-secret app settings live in the DB (editable from the Settings page).
// Secrets (API keys) live in env vars only and are never sent to the frontend.

export interface AppConfig {
  riskProfile: RiskProfile;
  riskPerTradePercent: number; // % of account value risked per trade
  minRiskReward: number;
  maxPortfolioConcentrationPercent: number; // per-position cap
  maxSectorConcentrationPercent: number;
  accountValue: number; // manual fallback when Alpaca not connected
  stopLossWarningPercent: number; // warn when within X% of stop
  drawdownWarningPercent: number;
  avoidEarningsWithinDays: number; // 0 = disabled
  staleDataMinutes: number; // data older than this is flagged stale
  catalystFreshnessDays: number; // catalysts older than this stop counting as current drivers/risks
  refreshIntervalMarketOpenSec: number;
  refreshIntervalExtendedHoursSec: number;
  refreshIntervalClosedSec: number;
  // Yahoo Finance connector: extended-hours quotes, news scan, earnings fetch,
  // and keyless daily bars — plain HTTP endpoints with the headless browser as
  // fallback (the browser layer itself is gated by env YAHOO_BROWSER_ENABLED).
  yahooEnabled: boolean;
  agentMinScore: number; // discovery agent proposes candidates scoring >= this (1–10)
  // When on, a cautious broad-market regime (SPY below its 50-day average)
  // raises the effective Agent Picks bar by 1 — a nudge, never a hard block.
  regimeFilterEnabled: boolean;
  portfolioWatchlistRecLimit: number; // max "add to watchlist" suggestions from holdings shown at once (0 hides)
  // Sector Scout scheduled auto-scan. When enabled, daily maintenance re-scans
  // each favorite industry (reusing agentMinScore as the threshold).
  sectorScoutScanEnabled: boolean;
  sectorScoutIndustries: string[]; // favorite industries/themes to auto-scan, e.g. ["space","energy"]
  sectorScoutThesisEnabled: boolean; // validate company claims/evidence during Sector Scout scans
  sectorScoutThesisMaxReports: number; // per-scan cap for deeper thesis work
  sectorScoutThesisMinScore: number; // thesis-only picks can surface at or above this score
  // Real-world event ingestion (Catalyst Edge). Master switch gates the scheduled
  // run; manual runs honor the per-source switches regardless.
  eventIngestionEnabled: boolean;
  eventSourceSecEnabled: boolean; // SEC EDGAR 8-K filings
  eventSourceGdeltEnabled: boolean; // GDELT news coverage (needs gdeltQueries)
  eventSourceIrEnabled: boolean; // company IR RSS (needs irFeeds)
  eventIngestionMaxItems: number; // per-run cap on raw items (cost control)
  eventMinConfidence: Confidence; // drop extracted events below this confidence
  gdeltQueries: string[]; // advanced: GDELT search queries (not in settings form)
  irFeeds: { ticker: string; url: string }[]; // advanced: IR feed URLs
  // Outbound alert notifications. Desktop notifications need no setup (macOS);
  // set an ntfy topic to also push to your phone via the ntfy app/web.
  notifyEnabled: boolean;
  notifyMinSeverity: "info" | "warning" | "critical"; // notify at or above this
  ntfyTopic: string; // empty = ntfy channel off; subscribe to this topic in ntfy
  // Opt-in daily morning brief (roadmap #39): one compact summary (market
  // regime, earnings inside the avoid window, trades flagged Exit/Trim,
  // buy-zone hits, fresh quality setups) delivered after the 08:00
  // maintenance refresh. Enabling it bypasses notifyMinSeverity — the toggle
  // itself is the opt-in — but the notifyEnabled master switch still applies.
  morningBriefEnabled: boolean;
  stockScoreWeights: {
    valuation: number;
    momentum: number;
    catalyst: number;
    risk: number;
    sentiment: number;
  };
  tradeScoreWeights: {
    technical: number;
    momentum: number;
    catalyst: number;
    riskReward: number;
    marketCondition: number;
    thesisValidity: number;
  };
}

export const DEFAULT_CONFIG: AppConfig = {
  riskProfile: "balanced",
  riskPerTradePercent: 1,
  minRiskReward: 2,
  maxPortfolioConcentrationPercent: 20,
  maxSectorConcentrationPercent: 35,
  accountValue: 10000,
  stopLossWarningPercent: 2,
  drawdownWarningPercent: 15,
  avoidEarningsWithinDays: 3,
  staleDataMinutes: 30,
  catalystFreshnessDays: 90,
  refreshIntervalMarketOpenSec: 120,
  refreshIntervalExtendedHoursSec: 600,
  refreshIntervalClosedSec: 2400,
  yahooEnabled: true,
  agentMinScore: 7,
  regimeFilterEnabled: false,
  portfolioWatchlistRecLimit: 3,
  sectorScoutScanEnabled: false,
  sectorScoutIndustries: [],
  sectorScoutThesisEnabled: true,
  sectorScoutThesisMaxReports: 6,
  sectorScoutThesisMinScore: 7,
  eventIngestionEnabled: false,
  eventSourceSecEnabled: true,
  eventSourceGdeltEnabled: false,
  eventSourceIrEnabled: false,
  eventIngestionMaxItems: 25,
  eventMinConfidence: "medium",
  gdeltQueries: [],
  irFeeds: [],
  notifyEnabled: false,
  notifyMinSeverity: "critical",
  ntfyTopic: "",
  morningBriefEnabled: false,
  stockScoreWeights: {
    valuation: 0.2,
    momentum: 0.2,
    catalyst: 0.25,
    risk: 0.25,
    sentiment: 0.1,
  },
  tradeScoreWeights: {
    technical: 0.3,
    momentum: 0.2,
    catalyst: 0.2,
    riskReward: 0.15,
    marketCondition: 0.1,
    thesisValidity: 0.05,
  },
};

// Risk profile adjustments applied on top of base config.
export const RISK_PROFILE_ADJUSTMENTS: Record<
  RiskProfile,
  Partial<Pick<AppConfig, "riskPerTradePercent" | "minRiskReward" | "avoidEarningsWithinDays" | "maxPortfolioConcentrationPercent">>
> = {
  conservative: {
    riskPerTradePercent: 0.5,
    minRiskReward: 2.5,
    avoidEarningsWithinDays: 5,
    maxPortfolioConcentrationPercent: 12,
  },
  balanced: {},
  aggressive: {
    riskPerTradePercent: 1.5,
    minRiskReward: 1.8,
    avoidEarningsWithinDays: 1,
    maxPortfolioConcentrationPercent: 30,
  },
};

const CONFIG_KEY = "app_config";

export function loadConfig(): AppConfig {
  try {
    const db = getDb();
    const row = db
      .select()
      .from(schema.appSettings)
      .where(eq(schema.appSettings.key, CONFIG_KEY))
      .get();
    if (!row) return DEFAULT_CONFIG;
    // `yahooEnabled` was called `yahooBrowserEnabled` before the connector went
    // HTTP-first; honor the legacy key (stripped here, so the next save
    // persists only the new name).
    const { yahooBrowserEnabled: legacyYahoo, ...stored } = JSON.parse(row.value) as Partial<AppConfig> & {
      yahooBrowserEnabled?: boolean;
    };
    return {
      ...DEFAULT_CONFIG,
      ...stored,
      yahooEnabled: stored.yahooEnabled ?? legacyYahoo ?? DEFAULT_CONFIG.yahooEnabled,
      stockScoreWeights: { ...DEFAULT_CONFIG.stockScoreWeights, ...stored.stockScoreWeights },
      tradeScoreWeights: { ...DEFAULT_CONFIG.tradeScoreWeights, ...stored.tradeScoreWeights },
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function saveConfig(partial: Partial<AppConfig>): AppConfig {
  const db = getDb();
  const merged = { ...loadConfig(), ...partial };
  const now = nowIso();
  db.insert(schema.appSettings)
    .values({ key: CONFIG_KEY, value: JSON.stringify(merged), updatedAt: now })
    .onConflictDoUpdate({
      target: schema.appSettings.key,
      set: { value: JSON.stringify(merged), updatedAt: now },
    })
    .run();
  return merged;
}

/** Config with risk-profile adjustments applied. Use this for risk decisions. */
export function effectiveConfig(cfg: AppConfig = loadConfig()): AppConfig {
  return { ...cfg, ...RISK_PROFILE_ADJUSTMENTS[cfg.riskProfile] };
}
