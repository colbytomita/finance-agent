import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import fs from "fs";
import path from "path";
import * as schema from "./schema";

// SQLite for MVP. The rest of the app talks only to the drizzle `db` object,
// so swapping to Postgres later means changing this file + schema imports only.

const DDL = `
CREATE TABLE IF NOT EXISTS portfolio_holdings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL UNIQUE,
  company_name TEXT,
  shares REAL NOT NULL DEFAULT 0,
  average_cost REAL NOT NULL DEFAULT 0,
  current_price REAL,
  market_value REAL,
  unrealized_gain_loss REAL,
  unrealized_gain_loss_percent REAL,
  source TEXT NOT NULL DEFAULT 'manual',
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS watchlist_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL UNIQUE,
  company_name TEXT,
  target_buy_low REAL,
  target_buy_high REAL,
  reinvest_above_price REAL,
  max_risk_price REAL,
  max_portfolio_weight REAL,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS market_price_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  regular_price REAL,
  pre_market_price REAL,
  after_hours_price REAL,
  day_change_percent REAL,
  market_state TEXT,
  source TEXT NOT NULL,
  captured_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_ticker_time ON market_price_snapshots (ticker, captured_at DESC);
CREATE TABLE IF NOT EXISTS drawdown_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  current_price REAL,
  high_water_mark REAL,
  drawdown_percent REAL,
  fifty_two_week_high REAL,
  fifty_two_week_low REAL,
  thirty_day_high REAL,
  drawdown_from_30d_high_percent REAL,
  distance_from_buy_zone_percent REAL,
  buy_zone_status TEXT,
  calculated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drawdown_ticker_time ON drawdown_metrics (ticker, calculated_at DESC);
CREATE TABLE IF NOT EXISTS catalysts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT,
  industry TEXT,
  title TEXT NOT NULL,
  summary TEXT,
  source_url TEXT,
  source_name TEXT NOT NULL DEFAULT 'manual',
  catalyst_type TEXT NOT NULL DEFAULT 'industry_news',
  event_date TEXT,
  discovered_at TEXT NOT NULL,
  impact_direction TEXT NOT NULL DEFAULT 'unknown',
  impact_score REAL NOT NULL DEFAULT 0,
  confidence TEXT NOT NULL DEFAULT 'low',
  status TEXT NOT NULL DEFAULT 'upcoming',
  tags TEXT,
  affects_active_trade INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS stock_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  overall_score REAL NOT NULL,
  valuation_score REAL NOT NULL,
  momentum_score REAL NOT NULL,
  catalyst_score REAL NOT NULL,
  risk_score REAL NOT NULL,
  technical_score REAL,
  sentiment_score REAL NOT NULL,
  recommendation TEXT NOT NULL,
  confidence TEXT NOT NULL DEFAULT 'low',
  reasoning_json TEXT,
  calculated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scores_ticker_time ON stock_scores (ticker, calculated_at DESC);
CREATE TABLE IF NOT EXISTS active_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'long',
  entry_price REAL NOT NULL,
  entry_date TEXT NOT NULL,
  shares REAL NOT NULL,
  position_size REAL,
  stop_loss REAL,
  target_price_1 REAL,
  target_price_2 REAL,
  current_price REAL,
  unrealized_gain_loss REAL,
  unrealized_gain_loss_percent REAL,
  max_gain_percent REAL,
  max_drawdown_percent REAL,
  trade_score REAL,
  recommendation TEXT,
  reasoning_json TEXT,
  thesis TEXT,
  invalidation_reason TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  exit_price REAL,
  broker TEXT,
  broker_order_id TEXT
);
CREATE TABLE IF NOT EXISTS trade_setups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  setup_type TEXT NOT NULL,
  setup_quality_score REAL NOT NULL,
  entry_range_low REAL NOT NULL,
  entry_range_high REAL NOT NULL,
  stop_loss REAL NOT NULL,
  target_price_1 REAL NOT NULL,
  target_price_2 REAL,
  risk_reward_ratio REAL NOT NULL,
  invalidation_condition TEXT,
  detected_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
);
CREATE TABLE IF NOT EXISTS trade_journal_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id INTEGER NOT NULL,
  ticker TEXT NOT NULL,
  entry_reason TEXT,
  entry_score REAL,
  exit_reason TEXT,
  exit_score REAL,
  profit_loss REAL,
  profit_loss_percent REAL,
  holding_period_days REAL,
  mistakes TEXT,
  lessons TEXT,
  catalyst_impact TEXT,
  thesis_played_out INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS research_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  title TEXT,
  summary TEXT,
  bull_case TEXT,
  bear_case TEXT,
  risks TEXT,
  sources_json TEXT,
  generated_by TEXT NOT NULL DEFAULT 'rules',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS price_bars (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  timeframe TEXT NOT NULL DEFAULT '1Day',
  bar_date TEXT NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume REAL NOT NULL,
  source TEXT NOT NULL DEFAULT 'alpaca',
  UNIQUE (ticker, timeframe, bar_date)
);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT,
  alert_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS entity_mentions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL,
  ticker TEXT NOT NULL,
  claim TEXT,
  direction TEXT NOT NULL DEFAULT 'unknown',
  event_date TEXT NOT NULL,
  source_name TEXT,
  source_url TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entity_mentions_entity ON entity_mentions (entity);
CREATE INDEX IF NOT EXISTS idx_entity_mentions_ticker_date ON entity_mentions (ticker, event_date);
CREATE TABLE IF NOT EXISTS score_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  score_type TEXT NOT NULL,
  score REAL NOT NULL,
  previous_score REAL,
  change_reason TEXT,
  recorded_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS earnings_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  fiscal_period TEXT,
  report_date TEXT NOT NULL,
  eps_estimate REAL,
  eps_actual REAL,
  revenue_estimate REAL,
  revenue_actual REAL,
  surprise_percent REAL,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL,
  UNIQUE (ticker, report_date)
);
CREATE INDEX IF NOT EXISTS idx_earnings_ticker_date ON earnings_reports (ticker, report_date DESC);
CREATE TABLE IF NOT EXISTS agent_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL UNIQUE,
  company_name TEXT,
  price REAL,
  overall_score REAL NOT NULL,
  valuation_score REAL,
  momentum_score REAL,
  catalyst_score REAL,
  risk_score REAL,
  sentiment_score REAL,
  recommendation TEXT,
  confidence TEXT NOT NULL DEFAULT 'low',
  drawdown_percent REAL,
  suggested_buy_low REAL,
  suggested_buy_high REAL,
  rationale TEXT,
  generated_by TEXT NOT NULL DEFAULT 'rules',
  status TEXT NOT NULL DEFAULT 'pending',
  proposed_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE TABLE IF NOT EXISTS sector_scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  industry TEXT NOT NULL,
  considered INTEGER NOT NULL DEFAULT 0,
  scanned INTEGER NOT NULL DEFAULT 0,
  proposed INTEGER NOT NULL DEFAULT 0,
  thesis_reports INTEGER NOT NULL DEFAULT 0,
  min_score REAL NOT NULL,
  expanded_by TEXT NOT NULL DEFAULT 'rules',
  ran_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sector_scans_industry_time ON sector_scans (industry, ran_at DESC);
CREATE TABLE IF NOT EXISTS company_thesis_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  company_name TEXT,
  industry TEXT NOT NULL,
  theme TEXT NOT NULL,
  summary TEXT,
  theme_fit_score REAL NOT NULL,
  claim_credibility_score REAL NOT NULL,
  moonshot_score REAL NOT NULL,
  evidence_quality_score REAL NOT NULL,
  hype_penalty REAL NOT NULL DEFAULT 0,
  overall_thesis_score REAL NOT NULL,
  verdict TEXT NOT NULL,
  generated_by TEXT NOT NULL DEFAULT 'rules',
  sources_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (ticker, theme)
);
CREATE INDEX IF NOT EXISTS idx_company_thesis_reports_ticker ON company_thesis_reports (ticker, updated_at DESC);
CREATE TABLE IF NOT EXISTS company_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL,
  ticker TEXT NOT NULL,
  claim TEXT NOT NULL,
  claim_type TEXT NOT NULL DEFAULT 'company_claim',
  probability_score REAL NOT NULL,
  evidence_summary TEXT,
  counter_evidence_summary TEXT,
  source_urls_json TEXT,
  confidence TEXT NOT NULL DEFAULT 'low',
  status TEXT NOT NULL DEFAULT 'unverified',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_company_claims_report ON company_claims (report_id);
CREATE INDEX IF NOT EXISTS idx_company_claims_ticker ON company_claims (ticker, created_at DESC);
CREATE TABLE IF NOT EXISTS sector_scout_picks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  industry TEXT NOT NULL,
  ticker TEXT NOT NULL,
  company_name TEXT,
  price REAL,
  overall_score REAL NOT NULL,
  valuation_score REAL,
  momentum_score REAL,
  catalyst_score REAL,
  risk_score REAL,
  sentiment_score REAL,
  recommendation TEXT,
  confidence TEXT NOT NULL DEFAULT 'low',
  drawdown_percent REAL,
  suggested_buy_low REAL,
  suggested_buy_high REAL,
  summary TEXT,
  bull_case TEXT,
  bear_case TEXT,
  key_catalysts TEXT,
  key_risks TEXT,
  recommended_action TEXT,
  brief_generated_by TEXT NOT NULL DEFAULT 'rules',
  thesis_report_id INTEGER,
  thesis_score REAL,
  theme_fit_score REAL,
  claim_credibility_score REAL,
  moonshot_score REAL,
  evidence_quality_score REAL,
  hype_penalty REAL,
  thesis_verdict TEXT,
  thesis_summary TEXT,
  thesis_generated_by TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  scanned_at TEXT NOT NULL,
  UNIQUE (industry, ticker)
);
CREATE INDEX IF NOT EXISTS idx_sector_picks_industry ON sector_scout_picks (industry, overall_score DESC);
`;

let _db: BetterSQLite3Database<typeof schema> | null = null;

export function getDb(): BetterSQLite3Database<typeof schema> {
  if (_db) return _db;
  const dbPath = process.env.DATABASE_PATH || "./data/finance-agent.db";
  const resolved = path.resolve(process.cwd(), dbPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const sqlite = new Database(resolved);
  sqlite.pragma("journal_mode = WAL");
  sqlite.exec(DDL);
  // Additive migrations for existing databases (the DDL above only creates
  // missing tables, never alters existing ones).
  for (const stmt of [
    "ALTER TABLE active_trades ADD COLUMN reasoning_json TEXT",
    "ALTER TABLE active_trades ADD COLUMN broker TEXT",
    "ALTER TABLE active_trades ADD COLUMN broker_order_id TEXT",
    "ALTER TABLE sector_scout_picks ADD COLUMN thesis_report_id INTEGER",
    "ALTER TABLE sector_scout_picks ADD COLUMN thesis_score REAL",
    "ALTER TABLE sector_scout_picks ADD COLUMN theme_fit_score REAL",
    "ALTER TABLE sector_scout_picks ADD COLUMN claim_credibility_score REAL",
    "ALTER TABLE sector_scout_picks ADD COLUMN moonshot_score REAL",
    "ALTER TABLE sector_scout_picks ADD COLUMN evidence_quality_score REAL",
    "ALTER TABLE sector_scout_picks ADD COLUMN hype_penalty REAL",
    "ALTER TABLE sector_scout_picks ADD COLUMN thesis_verdict TEXT",
    "ALTER TABLE sector_scout_picks ADD COLUMN thesis_summary TEXT",
    "ALTER TABLE sector_scout_picks ADD COLUMN thesis_generated_by TEXT",
    "ALTER TABLE sector_scans ADD COLUMN thesis_reports INTEGER NOT NULL DEFAULT 0",
  ]) {
    try {
      sqlite.exec(stmt);
    } catch {
      // Column already present — ignore.
    }
  }
  _db = drizzle(sqlite, { schema });
  return _db;
}

export { schema };
