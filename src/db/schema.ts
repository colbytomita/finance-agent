import {
  sqliteTable,
  text,
  integer,
  real,
} from "drizzle-orm/sqlite-core";

// Timestamps are stored as ISO-8601 strings (UTC) for portability to Postgres.

export const portfolioHoldings = sqliteTable("portfolio_holdings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ticker: text("ticker").notNull().unique(),
  companyName: text("company_name"),
  shares: real("shares").notNull().default(0),
  averageCost: real("average_cost").notNull().default(0),
  currentPrice: real("current_price"),
  marketValue: real("market_value"),
  unrealizedGainLoss: real("unrealized_gain_loss"),
  unrealizedGainLossPercent: real("unrealized_gain_loss_percent"),
  source: text("source").notNull().default("manual"), // manual | alpaca
  updatedAt: text("updated_at").notNull(),
});

export const watchlistItems = sqliteTable("watchlist_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ticker: text("ticker").notNull().unique(),
  companyName: text("company_name"),
  targetBuyLow: real("target_buy_low"),
  targetBuyHigh: real("target_buy_high"),
  reinvestAbovePrice: real("reinvest_above_price"),
  maxRiskPrice: real("max_risk_price"),
  maxPortfolioWeight: real("max_portfolio_weight"),
  notes: text("notes"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const marketPriceSnapshots = sqliteTable("market_price_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ticker: text("ticker").notNull(),
  regularPrice: real("regular_price"),
  preMarketPrice: real("pre_market_price"),
  afterHoursPrice: real("after_hours_price"),
  dayChangePercent: real("day_change_percent"),
  marketState: text("market_state"), // PRE | REGULAR | POST | CLOSED | UNKNOWN
  source: text("source").notNull(), // alpaca | yahoo-browser | manual
  capturedAt: text("captured_at").notNull(),
});

export const drawdownMetrics = sqliteTable("drawdown_metrics", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ticker: text("ticker").notNull(),
  currentPrice: real("current_price"),
  highWaterMark: real("high_water_mark"),
  drawdownPercent: real("drawdown_percent"),
  fiftyTwoWeekHigh: real("fifty_two_week_high"),
  fiftyTwoWeekLow: real("fifty_two_week_low"),
  thirtyDayHigh: real("thirty_day_high"),
  drawdownFrom30dHighPercent: real("drawdown_from_30d_high_percent"),
  distanceFromBuyZonePercent: real("distance_from_buy_zone_percent"),
  buyZoneStatus: text("buy_zone_status"),
  calculatedAt: text("calculated_at").notNull(),
});

export const catalysts = sqliteTable("catalysts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ticker: text("ticker"), // null => industry/macro-wide
  industry: text("industry"),
  title: text("title").notNull(),
  summary: text("summary"),
  sourceUrl: text("source_url"),
  sourceName: text("source_name").notNull().default("manual"),
  catalystType: text("catalyst_type").notNull().default("industry_news"),
  eventDate: text("event_date"), // may be null when unknown
  discoveredAt: text("discovered_at").notNull(),
  impactDirection: text("impact_direction").notNull().default("unknown"), // positive | negative | mixed | unknown
  impactScore: real("impact_score").notNull().default(0), // -5..+5
  confidence: text("confidence").notNull().default("low"), // low | medium | high
  status: text("status").notNull().default("upcoming"), // upcoming | occurred | expired
  tags: text("tags"), // comma-separated
  affectsActiveTrade: integer("affects_active_trade", { mode: "boolean" })
    .notNull()
    .default(false),
});

export const stockScores = sqliteTable("stock_scores", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ticker: text("ticker").notNull(),
  overallScore: real("overall_score").notNull(),
  valuationScore: real("valuation_score").notNull(),
  momentumScore: real("momentum_score").notNull(),
  catalystScore: real("catalyst_score").notNull(),
  riskScore: real("risk_score").notNull(),
  technicalScore: real("technical_score"),
  sentimentScore: real("sentiment_score").notNull(),
  recommendation: text("recommendation").notNull(),
  confidence: text("confidence").notNull().default("low"),
  reasoningJson: text("reasoning_json"),
  calculatedAt: text("calculated_at").notNull(),
});

export const activeTrades = sqliteTable("active_trades", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ticker: text("ticker").notNull(),
  direction: text("direction").notNull().default("long"), // long | short
  entryPrice: real("entry_price").notNull(),
  entryDate: text("entry_date").notNull(),
  shares: real("shares").notNull(),
  positionSize: real("position_size"),
  stopLoss: real("stop_loss"),
  targetPrice1: real("target_price_1"),
  targetPrice2: real("target_price_2"),
  currentPrice: real("current_price"),
  unrealizedGainLoss: real("unrealized_gain_loss"),
  unrealizedGainLossPercent: real("unrealized_gain_loss_percent"),
  maxGainPercent: real("max_gain_percent"),
  maxDrawdownPercent: real("max_drawdown_percent"),
  tradeScore: real("trade_score"),
  recommendation: text("recommendation"),
  reasoningJson: text("reasoning_json"),
  thesis: text("thesis"),
  invalidationReason: text("invalidation_reason"),
  status: text("status").notNull().default("open"), // open | closed
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  closedAt: text("closed_at"),
  exitPrice: real("exit_price"),
});

export const tradeSetups = sqliteTable("trade_setups", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ticker: text("ticker").notNull(),
  setupType: text("setup_type").notNull(),
  setupQualityScore: real("setup_quality_score").notNull(),
  entryRangeLow: real("entry_range_low").notNull(),
  entryRangeHigh: real("entry_range_high").notNull(),
  stopLoss: real("stop_loss").notNull(),
  targetPrice1: real("target_price_1").notNull(),
  targetPrice2: real("target_price_2"),
  riskRewardRatio: real("risk_reward_ratio").notNull(),
  invalidationCondition: text("invalidation_condition"),
  detectedAt: text("detected_at").notNull(),
  status: text("status").notNull().default("active"), // active | triggered | expired | invalidated
});

export const tradeJournalEntries = sqliteTable("trade_journal_entries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tradeId: integer("trade_id").notNull(),
  ticker: text("ticker").notNull(),
  entryReason: text("entry_reason"),
  entryScore: real("entry_score"),
  exitReason: text("exit_reason"),
  exitScore: real("exit_score"),
  profitLoss: real("profit_loss"),
  profitLossPercent: real("profit_loss_percent"),
  holdingPeriodDays: real("holding_period_days"),
  mistakes: text("mistakes"),
  lessons: text("lessons"),
  catalystImpact: text("catalyst_impact"),
  thesisPlayedOut: integer("thesis_played_out", { mode: "boolean" }),
  createdAt: text("created_at").notNull(),
});

export const researchNotes = sqliteTable("research_notes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ticker: text("ticker").notNull(),
  title: text("title"),
  summary: text("summary"),
  bullCase: text("bull_case"),
  bearCase: text("bear_case"),
  risks: text("risks"),
  sourcesJson: text("sources_json"),
  generatedBy: text("generated_by").notNull().default("rules"), // rules | llm | manual
  createdAt: text("created_at").notNull(),
});

export const priceBars = sqliteTable("price_bars", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ticker: text("ticker").notNull(),
  timeframe: text("timeframe").notNull().default("1Day"),
  barDate: text("bar_date").notNull(),
  open: real("open").notNull(),
  high: real("high").notNull(),
  low: real("low").notNull(),
  close: real("close").notNull(),
  volume: real("volume").notNull(),
  source: text("source").notNull().default("alpaca"),
});

export const alerts = sqliteTable("alerts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ticker: text("ticker"),
  alertType: text("alert_type").notNull(),
  severity: text("severity").notNull().default("info"), // info | warning | critical
  message: text("message").notNull(),
  acknowledged: integer("acknowledged", { mode: "boolean" })
    .notNull()
    .default(false),
  createdAt: text("created_at").notNull(),
});

// Simple key/value app settings (non-secret). Secrets stay in env vars.
export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(), // JSON-encoded
  updatedAt: text("updated_at").notNull(),
});

// AI-discovered watchlist candidates pending the user's accept/decline.
// The discovery agent proposes tickers that pass the configured score "test";
// accepting one promotes it into watchlist_items.
export const agentCandidates = sqliteTable("agent_candidates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ticker: text("ticker").notNull().unique(),
  companyName: text("company_name"),
  price: real("price"),
  overallScore: real("overall_score").notNull(),
  valuationScore: real("valuation_score"),
  momentumScore: real("momentum_score"),
  catalystScore: real("catalyst_score"),
  riskScore: real("risk_score"),
  sentimentScore: real("sentiment_score"),
  recommendation: text("recommendation"),
  confidence: text("confidence").notNull().default("low"),
  drawdownPercent: real("drawdown_percent"),
  suggestedBuyLow: real("suggested_buy_low"),
  suggestedBuyHigh: real("suggested_buy_high"),
  rationale: text("rationale"),
  generatedBy: text("generated_by").notNull().default("rules"), // rules | llm
  status: text("status").notNull().default("pending"), // pending | accepted | declined
  proposedAt: text("proposed_at").notNull(),
  decidedAt: text("decided_at"),
});

export const scoreHistory = sqliteTable("score_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ticker: text("ticker").notNull(),
  scoreType: text("score_type").notNull(), // stock | trade
  score: real("score").notNull(),
  previousScore: real("previous_score"),
  changeReason: text("change_reason"),
  recordedAt: text("recorded_at").notNull(),
});
