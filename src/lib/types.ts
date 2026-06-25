// Shared domain types. Pure data — no IO here.

export type Recommendation =
  | "Enter"
  | "Wait"
  | "Hold"
  | "Add"
  | "Trim"
  | "Exit"
  | "Avoid";

export type StockRecommendationLabel =
  | "Strong Buy Candidate"
  | "Buy Candidate"
  | "Watch / Hold"
  | "Avoid / Risk Elevated"
  | "Strong Avoid";

export type TradeRecommendationLabel =
  | "Strong Hold / Consider Add"
  | "Hold"
  | "Monitor Closely"
  | "Trim / Prepare Exit"
  | "Exit";

export type Confidence = "low" | "medium" | "high";

export type MarketState = "PRE" | "REGULAR" | "POST" | "CLOSED" | "UNKNOWN";

export type BuyZoneStatus =
  | "In Buy Zone"
  | "Below Buy Zone / Falling Knife Risk"
  | "Above Buy Zone / Wait"
  | "Reinvestment Candidate"
  | "Extended / Risk Elevated"
  | "No Buy Zone Set";

export type ImpactDirection = "positive" | "negative" | "mixed" | "unknown";

export type CatalystType =
  | "earnings"
  | "product_launch"
  | "conference"
  | "investor_day"
  | "executive_announcement"
  | "guidance_update"
  | "analyst_action"
  | "regulatory"
  | "litigation"
  | "macro"
  | "industry_news"
  | "competitor_news"
  | "ai_technology"
  | "ma"
  | "dividend_buyback"
  | "insider_trading"
  | "entity_mention";

export type SetupType =
  | "pullback_to_support"
  | "breakout"
  | "momentum_continuation"
  | "gap_and_go"
  | "post_earnings_drift"
  | "catalyst_driven"
  | "oversold_bounce"
  | "sector_rotation"
  | "ma_reclaim"
  | "high_volume_reversal";

export type RiskProfile = "conservative" | "balanced" | "aggressive";

export interface Bar {
  date: string; // ISO date
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Quote {
  ticker: string;
  regularPrice: number | null;
  preMarketPrice: number | null;
  afterHoursPrice: number | null;
  dayChangePercent: number | null;
  marketState: MarketState;
  source: string;
  sourceUrl?: string;
  capturedAt: string;
}

export interface BuyZoneConfig {
  targetBuyLow: number | null;
  targetBuyHigh: number | null;
  reinvestAbovePrice: number | null;
  maxRiskPrice: number | null;
}

export interface ScoreComponents {
  valuationScore: number;
  momentumScore: number;
  catalystScore: number;
  riskScore: number;
  sentimentScore: number;
}

export interface TradeScoreComponents {
  technicalScore: number;
  momentumScore: number;
  catalystScore: number;
  riskRewardScore: number;
  marketConditionScore: number;
  thesisValidityScore: number;
}

export interface DataFreshness {
  capturedAt: string | null;
  ageMinutes: number | null;
  isStale: boolean;
  label: string; // e.g. "2m ago", "stale (3h)", "no data"
}
