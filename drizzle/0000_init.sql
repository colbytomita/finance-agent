CREATE TABLE `active_trades` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ticker` text NOT NULL,
	`direction` text DEFAULT 'long' NOT NULL,
	`entry_price` real NOT NULL,
	`entry_date` text NOT NULL,
	`shares` real NOT NULL,
	`position_size` real,
	`stop_loss` real,
	`target_price_1` real,
	`target_price_2` real,
	`current_price` real,
	`unrealized_gain_loss` real,
	`unrealized_gain_loss_percent` real,
	`max_gain_percent` real,
	`max_drawdown_percent` real,
	`trade_score` real,
	`recommendation` text,
	`reasoning_json` text,
	`thesis` text,
	`invalidation_reason` text,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`closed_at` text,
	`exit_price` real,
	`broker` text,
	`broker_order_id` text,
	`broker_order_status` text
);
--> statement-breakpoint
CREATE TABLE `agent_candidates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ticker` text NOT NULL,
	`company_name` text,
	`price` real,
	`overall_score` real NOT NULL,
	`valuation_score` real,
	`momentum_score` real,
	`catalyst_score` real,
	`risk_score` real,
	`sentiment_score` real,
	`recommendation` text,
	`confidence` text DEFAULT 'low' NOT NULL,
	`drawdown_percent` real,
	`suggested_buy_low` real,
	`suggested_buy_high` real,
	`rationale` text,
	`generated_by` text DEFAULT 'rules' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`proposed_at` text NOT NULL,
	`decided_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_candidates_ticker_unique` ON `agent_candidates` (`ticker`);--> statement-breakpoint
CREATE TABLE `alerts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ticker` text,
	`alert_type` text NOT NULL,
	`severity` text DEFAULT 'info' NOT NULL,
	`message` text NOT NULL,
	`acknowledged` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `catalysts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ticker` text,
	`industry` text,
	`title` text NOT NULL,
	`summary` text,
	`source_url` text,
	`source_name` text DEFAULT 'manual' NOT NULL,
	`catalyst_type` text DEFAULT 'industry_news' NOT NULL,
	`event_date` text,
	`discovered_at` text NOT NULL,
	`impact_direction` text DEFAULT 'unknown' NOT NULL,
	`impact_score` real DEFAULT 0 NOT NULL,
	`confidence` text DEFAULT 'low' NOT NULL,
	`status` text DEFAULT 'upcoming' NOT NULL,
	`tags` text,
	`affects_active_trade` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `company_claims` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`report_id` integer NOT NULL,
	`ticker` text NOT NULL,
	`claim` text NOT NULL,
	`claim_type` text DEFAULT 'company_claim' NOT NULL,
	`probability_score` real NOT NULL,
	`evidence_summary` text,
	`counter_evidence_summary` text,
	`source_urls_json` text,
	`confidence` text DEFAULT 'low' NOT NULL,
	`status` text DEFAULT 'unverified' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_company_claims_report` ON `company_claims` (`report_id`);--> statement-breakpoint
CREATE INDEX `idx_company_claims_ticker` ON `company_claims` (`ticker`,`created_at`);--> statement-breakpoint
CREATE TABLE `company_thesis_reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ticker` text NOT NULL,
	`company_name` text,
	`industry` text NOT NULL,
	`theme` text NOT NULL,
	`summary` text,
	`theme_fit_score` real NOT NULL,
	`claim_credibility_score` real NOT NULL,
	`moonshot_score` real NOT NULL,
	`evidence_quality_score` real NOT NULL,
	`hype_penalty` real DEFAULT 0 NOT NULL,
	`overall_thesis_score` real NOT NULL,
	`verdict` text NOT NULL,
	`generated_by` text DEFAULT 'rules' NOT NULL,
	`sources_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_thesis_reports_ticker_theme_unique` ON `company_thesis_reports` (`ticker`,`theme`);--> statement-breakpoint
CREATE INDEX `idx_company_thesis_reports_ticker` ON `company_thesis_reports` (`ticker`,`updated_at`);--> statement-breakpoint
CREATE TABLE `drawdown_metrics` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ticker` text NOT NULL,
	`current_price` real,
	`high_water_mark` real,
	`drawdown_percent` real,
	`fifty_two_week_high` real,
	`fifty_two_week_low` real,
	`thirty_day_high` real,
	`drawdown_from_30d_high_percent` real,
	`distance_from_buy_zone_percent` real,
	`buy_zone_status` text,
	`calculated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_drawdown_ticker_time` ON `drawdown_metrics` (`ticker`,`calculated_at`);--> statement-breakpoint
CREATE TABLE `earnings_reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ticker` text NOT NULL,
	`fiscal_period` text,
	`report_date` text NOT NULL,
	`eps_estimate` real,
	`eps_actual` real,
	`revenue_estimate` real,
	`revenue_actual` real,
	`surprise_percent` real,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `earnings_reports_ticker_report_date_unique` ON `earnings_reports` (`ticker`,`report_date`);--> statement-breakpoint
CREATE INDEX `idx_earnings_ticker_date` ON `earnings_reports` (`ticker`,`report_date`);--> statement-breakpoint
CREATE TABLE `entity_mentions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entity` text NOT NULL,
	`ticker` text NOT NULL,
	`claim` text,
	`direction` text DEFAULT 'unknown' NOT NULL,
	`event_date` text NOT NULL,
	`source_name` text,
	`source_url` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_entity_mentions_entity` ON `entity_mentions` (`entity`);--> statement-breakpoint
CREATE INDEX `idx_entity_mentions_ticker_date` ON `entity_mentions` (`ticker`,`event_date`);--> statement-breakpoint
CREATE TABLE `ingestion_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trigger` text DEFAULT 'manual' NOT NULL,
	`fetched` integer DEFAULT 0 NOT NULL,
	`extracted` integer DEFAULT 0 NOT NULL,
	`persisted` integer DEFAULT 0 NOT NULL,
	`catalysts_added` integer DEFAULT 0 NOT NULL,
	`skipped` integer DEFAULT 0 NOT NULL,
	`generated_by` text DEFAULT 'none' NOT NULL,
	`by_source` text,
	`error_count` integer DEFAULT 0 NOT NULL,
	`errors_json` text,
	`ran_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_ingestion_runs_time` ON `ingestion_runs` (`ran_at`);--> statement-breakpoint
CREATE TABLE `job_runs` (
	`job` text PRIMARY KEY NOT NULL,
	`last_run_at` text NOT NULL,
	`status` text DEFAULT 'ok' NOT NULL,
	`message` text
);
--> statement-breakpoint
CREATE TABLE `market_price_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ticker` text NOT NULL,
	`regular_price` real,
	`pre_market_price` real,
	`after_hours_price` real,
	`day_change_percent` real,
	`market_state` text,
	`source` text NOT NULL,
	`captured_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_snapshots_ticker_time` ON `market_price_snapshots` (`ticker`,`captured_at`);--> statement-breakpoint
CREATE TABLE `portfolio_holdings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ticker` text NOT NULL,
	`company_name` text,
	`shares` real DEFAULT 0 NOT NULL,
	`average_cost` real DEFAULT 0 NOT NULL,
	`current_price` real,
	`market_value` real,
	`unrealized_gain_loss` real,
	`unrealized_gain_loss_percent` real,
	`source` text DEFAULT 'manual' NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `portfolio_holdings_ticker_unique` ON `portfolio_holdings` (`ticker`);--> statement-breakpoint
CREATE TABLE `price_bars` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ticker` text NOT NULL,
	`timeframe` text DEFAULT '1Day' NOT NULL,
	`bar_date` text NOT NULL,
	`open` real NOT NULL,
	`high` real NOT NULL,
	`low` real NOT NULL,
	`close` real NOT NULL,
	`volume` real NOT NULL,
	`source` text DEFAULT 'alpaca' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `price_bars_ticker_timeframe_bar_date_unique` ON `price_bars` (`ticker`,`timeframe`,`bar_date`);--> statement-breakpoint
CREATE TABLE `research_notes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ticker` text NOT NULL,
	`title` text,
	`summary` text,
	`bull_case` text,
	`bear_case` text,
	`risks` text,
	`sources_json` text,
	`generated_by` text DEFAULT 'rules' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `score_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ticker` text NOT NULL,
	`score_type` text NOT NULL,
	`score` real NOT NULL,
	`previous_score` real,
	`change_reason` text,
	`recorded_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sector_scans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`industry` text NOT NULL,
	`considered` integer DEFAULT 0 NOT NULL,
	`scanned` integer DEFAULT 0 NOT NULL,
	`proposed` integer DEFAULT 0 NOT NULL,
	`thesis_reports` integer DEFAULT 0 NOT NULL,
	`min_score` real NOT NULL,
	`expanded_by` text DEFAULT 'rules' NOT NULL,
	`ran_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_sector_scans_industry_time` ON `sector_scans` (`industry`,`ran_at`);--> statement-breakpoint
CREATE TABLE `sector_scout_picks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`industry` text NOT NULL,
	`ticker` text NOT NULL,
	`company_name` text,
	`price` real,
	`overall_score` real NOT NULL,
	`valuation_score` real,
	`momentum_score` real,
	`catalyst_score` real,
	`risk_score` real,
	`sentiment_score` real,
	`recommendation` text,
	`confidence` text DEFAULT 'low' NOT NULL,
	`drawdown_percent` real,
	`suggested_buy_low` real,
	`suggested_buy_high` real,
	`summary` text,
	`bull_case` text,
	`bear_case` text,
	`key_catalysts` text,
	`key_risks` text,
	`recommended_action` text,
	`brief_generated_by` text DEFAULT 'rules' NOT NULL,
	`thesis_report_id` integer,
	`thesis_score` real,
	`theme_fit_score` real,
	`claim_credibility_score` real,
	`moonshot_score` real,
	`evidence_quality_score` real,
	`hype_penalty` real,
	`thesis_verdict` text,
	`thesis_summary` text,
	`thesis_generated_by` text,
	`status` text DEFAULT 'new' NOT NULL,
	`scanned_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sector_scout_picks_industry_ticker_unique` ON `sector_scout_picks` (`industry`,`ticker`);--> statement-breakpoint
CREATE INDEX `idx_sector_picks_industry` ON `sector_scout_picks` (`industry`,`overall_score`);--> statement-breakpoint
CREATE TABLE `stock_scores` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ticker` text NOT NULL,
	`overall_score` real NOT NULL,
	`valuation_score` real NOT NULL,
	`momentum_score` real NOT NULL,
	`catalyst_score` real NOT NULL,
	`risk_score` real NOT NULL,
	`technical_score` real,
	`sentiment_score` real NOT NULL,
	`recommendation` text NOT NULL,
	`confidence` text DEFAULT 'low' NOT NULL,
	`reasoning_json` text,
	`calculated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_scores_ticker_time` ON `stock_scores` (`ticker`,`calculated_at`);--> statement-breakpoint
CREATE TABLE `trade_journal_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trade_id` integer NOT NULL,
	`ticker` text NOT NULL,
	`entry_reason` text,
	`entry_score` real,
	`exit_reason` text,
	`exit_score` real,
	`profit_loss` real,
	`profit_loss_percent` real,
	`holding_period_days` real,
	`mistakes` text,
	`lessons` text,
	`catalyst_impact` text,
	`thesis_played_out` integer,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `trade_setups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ticker` text NOT NULL,
	`setup_type` text NOT NULL,
	`setup_quality_score` real NOT NULL,
	`entry_range_low` real NOT NULL,
	`entry_range_high` real NOT NULL,
	`stop_loss` real NOT NULL,
	`target_price_1` real NOT NULL,
	`target_price_2` real,
	`risk_reward_ratio` real NOT NULL,
	`invalidation_condition` text,
	`detected_at` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `watchlist_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ticker` text NOT NULL,
	`company_name` text,
	`target_buy_low` real,
	`target_buy_high` real,
	`reinvest_above_price` real,
	`max_risk_price` real,
	`max_portfolio_weight` real,
	`notes` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `watchlist_items_ticker_unique` ON `watchlist_items` (`ticker`);