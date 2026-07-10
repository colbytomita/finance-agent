import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
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
  // GICS-style sector from Yahoo assetProfile (roadmap #37), backfilled by
  // daily maintenance; enables sector-concentration warnings + the breakdown.
  sector: text("sector"),
  updatedAt: text("updated_at").notNull(),
});

// Daily account-value history (roadmap #31): one row per calendar day,
// upserted on refresh — the equity curve the current-state holdings table
// can't provide. Real data only; rows accumulate from the day the feature
// ships, no backfill.
export const portfolioSnapshots = sqliteTable("portfolio_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  snapshotDate: text("snapshot_date").notNull().unique(), // local YYYY-MM-DD
  holdingsValue: real("holdings_value").notNull(),
  openTradesValue: real("open_trades_value").notNull(),
  totalValue: real("total_value").notNull(),
  holdingCount: integer("holding_count").notNull(),
  capturedAt: text("captured_at").notNull(),
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
  source: text("source").notNull(), // alpaca | yahoo (HTTP) | yahoo-browser (fallback) | manual
  capturedAt: text("captured_at").notNull(),
}, (t) => [index("idx_snapshots_ticker_time").on(t.ticker, t.capturedAt)]);

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
}, (t) => [index("idx_drawdown_ticker_time").on(t.ticker, t.calculatedAt)]);

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
}, (t) => [index("idx_scores_ticker_time").on(t.ticker, t.calculatedAt)]);

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
  status: text("status").notNull().default("open"), // open | closed | canceled (broker order died unfilled)
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  closedAt: text("closed_at"),
  exitPrice: real("exit_price"),
  // Set when the trade was placed through a broker (Alpaca). Manual log-only
  // trades leave these null.
  broker: text("broker"), // e.g. alpaca-paper | alpaca-live
  brokerOrderId: text("broker_order_id"),
  // Last synced Alpaca order status (services/orderSync). Terminal statuses
  // (filled/canceled/expired/rejected/replaced) stop polling for that trade.
  brokerOrderStatus: text("broker_order_status"),
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
}, (t) => [uniqueIndex("price_bars_ticker_timeframe_bar_date_unique").on(t.ticker, t.timeframe, t.barDate)]);

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
  fundamentalsScore: real("fundamentals_score"), // company fundamentals read (1–10), leads the pick score
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

// Real-world "who said what about which ticker" events, used by the event-study
// ("catalyst edge") engine to measure how a ticker moved before/after a given
// entity mentioned it, pooled across all of that entity's prior mentions.
export const entityMentions = sqliteTable("entity_mentions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  entity: text("entity").notNull(), // speaker/source, e.g. "Donald Trump"
  ticker: text("ticker").notNull(), // referenced stock, uppercase
  claim: text("claim"), // short description of what was said
  direction: text("direction").notNull().default("unknown"), // bullish | bearish | neutral | unknown
  eventDate: text("event_date").notNull(), // ISO-8601 date the statement happened
  sourceName: text("source_name"),
  sourceUrl: text("source_url"),
  createdAt: text("created_at").notNull(),
}, (t) => [
  index("idx_entity_mentions_entity").on(t.entity),
  index("idx_entity_mentions_ticker_date").on(t.ticker, t.eventDate),
]);

export const watchedEntities = sqliteTable("watched_entities", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  entity: text("entity").notNull().unique(), // starred speaker/source; new mentions raise an alert
  createdAt: text("created_at").notNull(),
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

// Sector Scout: on-demand, industry-targeted discovery. The user types an
// industry/theme ("space", "energy", "nuclear fusion"); we expand it into real
// tickers, score each with the normal engine, and write a full research brief
// for the ones that clear the score test. `sectorScans` is the per-run log;
// `sectorScoutPicks` holds the surfaced picks (one row per industry+ticker).
export const sectorScans = sqliteTable("sector_scans", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  industry: text("industry").notNull(), // normalized label the user searched
  considered: integer("considered").notNull().default(0), // tickers the expander proposed
  scanned: integer("scanned").notNull().default(0), // tickers with real data that got scored
  proposed: integer("proposed").notNull().default(0), // picks that cleared the score test
  thesisReports: integer("thesis_reports").notNull().default(0), // deeper company-claim reports generated
  minScore: real("min_score").notNull(), // threshold used for this run
  expandedBy: text("expanded_by").notNull().default("rules"), // llm | rules (how tickers were sourced)
  meanPickScore: real("mean_pick_score"), // mean overall score of picks that cleared the test
  maxPickScore: real("max_pick_score"), // best pick score this run
  ranAt: text("ran_at").notNull(),
}, (t) => [index("idx_sector_scans_industry_time").on(t.industry, t.ranAt)]);

// Sector Scout thesis validation. A report is the latest evidence-backed view
// of one ticker for one searched theme; claims are the individual assertions the
// app found and scored. Scores are heuristic evidence ratings, not predictions.
export const companyThesisReports = sqliteTable("company_thesis_reports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ticker: text("ticker").notNull(),
  companyName: text("company_name"),
  industry: text("industry").notNull(),
  theme: text("theme").notNull(),
  summary: text("summary"),
  themeFitScore: real("theme_fit_score").notNull(),
  claimCredibilityScore: real("claim_credibility_score").notNull(),
  moonshotScore: real("moonshot_score").notNull(),
  evidenceQualityScore: real("evidence_quality_score").notNull(),
  hypePenalty: real("hype_penalty").notNull().default(0),
  overallThesisScore: real("overall_thesis_score").notNull(),
  verdict: text("verdict").notNull(),
  generatedBy: text("generated_by").notNull().default("rules"), // llm | rules
  sourcesJson: text("sources_json"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  uniqueIndex("company_thesis_reports_ticker_theme_unique").on(t.ticker, t.theme),
  index("idx_company_thesis_reports_ticker").on(t.ticker, t.updatedAt),
]);

export const companyClaims = sqliteTable("company_claims", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  reportId: integer("report_id").notNull(),
  ticker: text("ticker").notNull(),
  claim: text("claim").notNull(),
  claimType: text("claim_type").notNull().default("company_claim"),
  probabilityScore: real("probability_score").notNull(),
  evidenceSummary: text("evidence_summary"),
  counterEvidenceSummary: text("counter_evidence_summary"),
  sourceUrlsJson: text("source_urls_json"),
  confidence: text("confidence").notNull().default("low"),
  status: text("status").notNull().default("unverified"),
  createdAt: text("created_at").notNull(),
}, (t) => [
  index("idx_company_claims_report").on(t.reportId),
  index("idx_company_claims_ticker").on(t.ticker, t.createdAt),
]);

export const sectorScoutPicks = sqliteTable("sector_scout_picks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  industry: text("industry").notNull(),
  ticker: text("ticker").notNull(),
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
  // Full research brief fields (bull/bear/risk), generated per pick.
  summary: text("summary"),
  bullCase: text("bull_case"),
  bearCase: text("bear_case"),
  keyCatalysts: text("key_catalysts"), // JSON array of strings
  keyRisks: text("key_risks"), // JSON array of strings
  recommendedAction: text("recommended_action"),
  briefGeneratedBy: text("brief_generated_by").notNull().default("rules"), // llm | rules
  thesisReportId: integer("thesis_report_id"),
  thesisScore: real("thesis_score"),
  themeFitScore: real("theme_fit_score"),
  claimCredibilityScore: real("claim_credibility_score"),
  moonshotScore: real("moonshot_score"),
  evidenceQualityScore: real("evidence_quality_score"),
  hypePenalty: real("hype_penalty"),
  thesisVerdict: text("thesis_verdict"),
  thesisSummary: text("thesis_summary"),
  thesisGeneratedBy: text("thesis_generated_by"),
  status: text("status").notNull().default("new"), // new | added | dismissed
  scannedAt: text("scanned_at").notNull(),
}, (t) => [
  // Mirrors the runtime DDL's `UNIQUE (industry, ticker)` — one pick row per
  // industry+ticker. The upsert in runSectorScan conflict-targets these columns.
  uniqueIndex("sector_scout_picks_industry_ticker_unique").on(t.industry, t.ticker),
  index("idx_sector_picks_industry").on(t.industry, t.overallScore),
]);

// Quarterly earnings results: actual vs. analyst estimate (the "beat / meet / miss").
// Feeds the scoring engine as a recency-decayed earnings-surprise signal.
export const earningsReports = sqliteTable("earnings_reports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ticker: text("ticker").notNull(),
  fiscalPeriod: text("fiscal_period"), // e.g. "Q2 2026"
  reportDate: text("report_date").notNull(), // ISO date the results were reported
  epsEstimate: real("eps_estimate"),
  epsActual: real("eps_actual"),
  revenueEstimate: real("revenue_estimate"),
  revenueActual: real("revenue_actual"),
  surprisePercent: real("surprise_percent"), // EPS surprise %, + = beat / − = miss
  source: text("source").notNull().default("manual"), // manual | yahoo
  createdAt: text("created_at").notNull(),
}, (t) => [
  uniqueIndex("earnings_reports_ticker_report_date_unique").on(t.ticker, t.reportDate),
  index("idx_earnings_ticker_date").on(t.ticker, t.reportDate),
]);

// Per-run log of real-world event ingestion (Catalyst Edge). One row per
// runEventIngestion call so the Events page can show when it last ran, what each
// source produced, and how the extraction went — manual button or scheduled job.
export const ingestionRuns = sqliteTable("ingestion_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  trigger: text("trigger").notNull().default("manual"), // manual | scheduled
  fetched: integer("fetched").notNull().default(0),
  extracted: integer("extracted").notNull().default(0),
  persisted: integer("persisted").notNull().default(0),
  catalystsAdded: integer("catalysts_added").notNull().default(0),
  skipped: integer("skipped").notNull().default(0),
  generatedBy: text("generated_by").notNull().default("none"), // llm | rules | mixed | none
  bySource: text("by_source"), // JSON: { "sec-edgar": n, gdelt: n, "ir-rss": n }
  errorCount: integer("error_count").notNull().default(0),
  errorsJson: text("errors_json"), // JSON array of error strings (capped)
  skippedJson: text("skipped_json"), // JSON array of { title, reason } (capped)
  ranAt: text("ran_at").notNull(),
}, (t) => [index("idx_ingestion_runs_time").on(t.ranAt)]);

// Scheduler heartbeat: one row per job name, upserted on every run/tick so the
// UI can show "jobs last ran X min ago" and flag a dead `npm run jobs` process.
export const jobRuns = sqliteTable("job_runs", {
  job: text("job").primaryKey(), // heartbeat | refresh | daily_maintenance | catalyst_scan
  lastRunAt: text("last_run_at").notNull(),
  status: text("status").notNull().default("ok"), // ok | error
  message: text("message"), // last error message when status = error
});
