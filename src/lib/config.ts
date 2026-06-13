import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { RiskProfile } from "./types";

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
  refreshIntervalMarketOpenSec: number;
  refreshIntervalExtendedHoursSec: number;
  refreshIntervalClosedSec: number;
  yahooBrowserEnabled: boolean;
  agentMinScore: number; // discovery agent proposes candidates scoring >= this (1–10)
  portfolioWatchlistRecLimit: number; // max "add to watchlist" suggestions from holdings shown at once (0 hides)
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
  refreshIntervalMarketOpenSec: 120,
  refreshIntervalExtendedHoursSec: 600,
  refreshIntervalClosedSec: 2400,
  yahooBrowserEnabled: true,
  agentMinScore: 7,
  portfolioWatchlistRecLimit: 3,
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
    const stored = JSON.parse(row.value) as Partial<AppConfig>;
    return {
      ...DEFAULT_CONFIG,
      ...stored,
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
  const now = new Date().toISOString();
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
