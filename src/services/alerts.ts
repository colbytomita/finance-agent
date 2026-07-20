import { and, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { loadConfig } from "@/lib/config";
import { activeSetups } from "@/lib/queries";
import { freshness } from "@/lib/format";
import { nowIso } from "@/lib/util";
import { currentAccountValue, getLatestSnapshot } from "./marketData";
import { concentrationWarnings } from "./riskManagement";
import { queueAlertNotification } from "./notifications";

// Alert generation. Idempotent per day: an identical (type, ticker, message)
// emitted within the last 20h is not duplicated.

export type AlertSeverity = "info" | "warning" | "critical";

export interface EmitAlertOptions {
  /**
   * Condition-state alerts (roadmap #45): skip when an *unacknowledged*
   * alert of the same (type, ticker) already exists, regardless of message
   * or age — a stop that stays breached or a ticker that stays stale should
   * not re-alert daily just because the embedded price/age changed.
   * Acknowledging (or #36's auto-ack) re-arms the alert.
   */
  onceWhileUnacked?: boolean;
}

/** Shorthand for the condition-state alerts in generateAlerts (roadmap #45). */
const ONCE: EmitAlertOptions = { onceWhileUnacked: true };

/**
 * Minimum stale tickers before a majority-stale board collapses into one
 * aggregate alert instead of a per-ticker wave (roadmap #59).
 */
const STALE_WAVE_MIN = 10;

/**
 * Emit one alert (de-duplicated: an identical type+message within the last 20h
 * is dropped). Exported for services that raise event-driven alerts outside the
 * scan in generateAlerts (e.g. broker order-fill corrections).
 */
export function emitAlert(
  alertType: string,
  severity: AlertSeverity,
  message: string,
  ticker: string | null = null,
  opts: EmitAlertOptions = {},
): boolean {
  return emit(alertType, severity, message, ticker, opts);
}

function emit(
  alertType: string,
  severity: AlertSeverity,
  message: string,
  ticker: string | null = null,
  opts: EmitAlertOptions = {},
): boolean {
  const db = getDb();
  if (opts.onceWhileUnacked) {
    const open = db
      .select({ id: schema.alerts.id })
      .from(schema.alerts)
      .where(
        and(
          eq(schema.alerts.alertType, alertType),
          eq(schema.alerts.acknowledged, false),
          ticker == null ? isNull(schema.alerts.ticker) : eq(schema.alerts.ticker, ticker),
        ),
      )
      .get();
    if (open) return false;
  }
  const since = new Date(Date.now() - 20 * 3600 * 1000).toISOString();
  const dupe = db
    .select()
    .from(schema.alerts)
    .where(
      and(
        eq(schema.alerts.alertType, alertType),
        eq(schema.alerts.message, message),
        gte(schema.alerts.createdAt, since),
      ),
    )
    .get();
  if (dupe) return false;
  db.insert(schema.alerts)
    .values({
      ticker,
      alertType,
      severity,
      message,
      acknowledged: false,
      createdAt: nowIso(),
    })
    .run();
  // Push out-of-app (desktop/ntfy) when configured — best effort, non-blocking.
  // Queued: alerts inserted within the same burst arrive as one digest.
  queueAlertNotification(severity, message, ticker);
  return true;
}

// --- Condition-alert lifecycle (roadmap #49) ---
// A condition alert should live exactly as long as its condition: #45 stops
// re-emits while one is unacked; this closes the other half by auto-acking
// rows whose condition has cleared. Event alerts (order fills/cancels,
// auto-closes, major_catalyst, mentions, morning brief) are records of
// things that happened — they are never auto-acked here. new_setup joined
// the fluid conditions in #58: a setup is not an event but a state with a
// natural end (its episode), and treating it as an event let quality drift
// mint duplicate rows while a 113-row unacked backlog accumulated.

/** Condition types that clear as soon as a scan stops finding them true. */
const FLUID_CONDITION_TYPES = [
  "near_stop_loss",
  "target_hit",
  "trade_score_low",
  "trade_score_critical",
  "exit_recommended",
  "trim_recommended",
  "add_opportunity",
  "entry_range_reached",
  "concentration",
  "data_stale",
  "new_setup",
];

/**
 * Critical conditions that stay visible while the trade is open — an intraday
 * stop breach matters even if price recovers — and clear only when the ticker
 * has no open trade left.
 */
const STICKY_TRADE_TYPES = ["stop_loss_hit", "thesis_invalidated"];

/** Trade-scoped condition types, acked immediately when a trade closes. */
const TRADE_CONDITION_TYPES = [
  ...STICKY_TRADE_TYPES,
  "near_stop_loss",
  "target_hit",
  "trade_score_low",
  "trade_score_critical",
  "exit_recommended",
  "trim_recommended",
  "add_opportunity",
];

/**
 * Acknowledge unacked trade-condition alerts for a ticker whose trade just
 * closed (roadmap #49). On a ticker with several trades, the next scan simply
 * re-emits anything still true for the remaining open ones (#45's ack re-arm).
 */
export function ackTradeConditionAlerts(ticker: string): number {
  const res = getDb()
    .update(schema.alerts)
    .set({ acknowledged: true })
    .where(
      and(
        eq(schema.alerts.acknowledged, false),
        eq(schema.alerts.ticker, ticker.toUpperCase()),
        inArray(schema.alerts.alertType, TRADE_CONDITION_TYPES),
      ),
    )
    .run();
  return Number(res.changes);
}

/** Auto-ack unacked condition alerts whose condition was not seen this scan. */
function ackClearedConditionAlerts(active: Map<string, Set<string | null>>): number {
  const db = getDb();
  let acked = 0;
  for (const type of [...FLUID_CONDITION_TYPES, ...STICKY_TRADE_TYPES]) {
    const still = active.get(type);
    const rows = db
      .select({ id: schema.alerts.id, ticker: schema.alerts.ticker })
      .from(schema.alerts)
      .where(and(eq(schema.alerts.alertType, type), eq(schema.alerts.acknowledged, false)))
      .all();
    for (const r of rows) {
      if (still?.has(r.ticker)) continue;
      db.update(schema.alerts).set({ acknowledged: true }).where(eq(schema.alerts.id, r.id)).run();
      acked++;
    }
  }
  return acked;
}

/** Scan current state and produce alerts. Returns number of new alerts. */
export function generateAlerts(): number {
  const db = getDb();
  const cfg = loadConfig();
  let created = 0;
  const count = (ok: boolean) => {
    if (ok) created++;
  };
  // Condition-true bookkeeping for the post-scan clear pass (roadmap #49),
  // marked whether or not the emit deduped.
  const active = new Map<string, Set<string | null>>();
  const mark = (type: string, ticker: string | null) => {
    let set = active.get(type);
    if (!set) active.set(type, (set = new Set()));
    set.add(ticker);
  };

  // --- Open trade alerts ---
  const trades = db
    .select()
    .from(schema.activeTrades)
    .where(eq(schema.activeTrades.status, "open"))
    .all();
  for (const t of trades) {
    // Sticky criticals stay armed for any ticker with an open trade — they
    // clear on trade close (see ackTradeConditionAlerts), not price recovery.
    mark("stop_loss_hit", t.ticker);
    mark("thesis_invalidated", t.ticker);

    const price = t.currentPrice;
    if (price == null) continue;
    const long = t.direction !== "short";

    if (t.stopLoss != null) {
      const hit = long ? price <= t.stopLoss : price >= t.stopLoss;
      const near =
        !hit &&
        Math.abs((price - t.stopLoss) / price) * 100 <= cfg.stopLossWarningPercent;
      if (hit) {
        count(
          emit("stop_loss_hit", "critical", `${t.ticker}: stop-loss ${t.stopLoss} hit (price ${price}). Review exit.`, t.ticker, ONCE),
        );
      } else if (near) {
        mark("near_stop_loss", t.ticker);
        count(
          emit("near_stop_loss", "warning", `${t.ticker}: within ${cfg.stopLossWarningPercent}% of stop-loss ${t.stopLoss}.`, t.ticker, ONCE),
        );
      }
    }
    if (t.targetPrice1 != null) {
      const hit = long ? price >= t.targetPrice1 : price <= t.targetPrice1;
      if (hit) {
        mark("target_hit", t.ticker);
        count(
          emit("target_hit", "info", `${t.ticker}: target 1 (${t.targetPrice1}) reached — trim rules apply.`, t.ticker, ONCE),
        );
      }
    }
    if (t.tradeScore != null && t.tradeScore < 3) {
      mark("trade_score_critical", t.ticker);
      count(
        emit("trade_score_critical", "critical", `${t.ticker}: trade score ${t.tradeScore.toFixed(1)} — exit recommended.`, t.ticker, ONCE),
      );
    } else if (t.tradeScore != null && t.tradeScore < 5) {
      count(
        emit("trade_score_low", "warning", `${t.ticker}: trade score dropped to ${t.tradeScore.toFixed(1)} — monitor closely.`, t.ticker, ONCE),
      );
    }
    // A low score keeps the (worse) critical row armed too, so an unacked
    // "score < 3" alert doesn't auto-ack the moment the score ticks up to 4.
    if (t.tradeScore != null && t.tradeScore < 5) mark("trade_score_low", t.ticker);
    if (t.recommendation === "Exit") {
      mark("exit_recommended", t.ticker);
      count(emit("exit_recommended", "critical", `${t.ticker}: EXIT recommended.`, t.ticker, ONCE));
    } else if (t.recommendation === "Trim") {
      mark("trim_recommended", t.ticker);
      count(emit("trim_recommended", "warning", `${t.ticker}: trim recommended.`, t.ticker, ONCE));
    } else if (t.recommendation === "Add") {
      mark("add_opportunity", t.ticker);
      count(emit("add_opportunity", "info", `${t.ticker}: add conditions met (score ${t.tradeScore?.toFixed(1)}).`, t.ticker, ONCE));
    }
    if (t.invalidationReason) {
      count(
        emit("thesis_invalidated", "critical", `${t.ticker}: thesis invalidated — ${t.invalidationReason}`, t.ticker, ONCE),
      );
    }
  }

  // --- Account concentration (roadmap #30) ---
  // Positions = holdings, plus open trades for tickers not already held (a
  // broker-synced position already includes a swing trade's shares — summing
  // both would double-count the exposure). Sectors come from the holdings'
  // Yahoo-backfilled column (roadmap #37); rows without one only count
  // toward the per-position check.
  const holdings = db.select().from(schema.portfolioHoldings).all();
  const positionValues = new Map<string, { value: number; sector: string | null }>();
  for (const h of holdings) {
    if (h.marketValue != null)
      positionValues.set(h.ticker, { value: h.marketValue, sector: h.sector });
  }
  for (const t of trades) {
    if (!positionValues.has(t.ticker) && t.currentPrice != null) {
      positionValues.set(t.ticker, { value: t.shares * t.currentPrice, sector: null });
    }
  }
  const concWarnings = concentrationWarnings({
    positions: [...positionValues].map(([ticker, p]) => ({ ticker, ...p })),
    accountValue: currentAccountValue(),
    maxPositionWeightPercent: cfg.maxPortfolioConcentrationPercent,
    maxSectorWeightPercent: cfg.maxSectorConcentrationPercent,
  });
  for (const w of concWarnings) {
    const ticker = [...positionValues.keys()].find((t) => w.startsWith(`${t} `)) ?? null;
    mark("concentration", ticker);
    count(emit("concentration", "warning", w, ticker, ONCE));
  }

  // --- Buy zone / setup alerts ---
  const watch = db.select().from(schema.watchlistItems).all();
  for (const w of watch) {
    const dd = db
      .select()
      .from(schema.drawdownMetrics)
      .where(eq(schema.drawdownMetrics.ticker, w.ticker))
      .orderBy(desc(schema.drawdownMetrics.calculatedAt))
      .limit(1)
      .get();
    if (dd?.buyZoneStatus === "In Buy Zone") {
      mark("entry_range_reached", w.ticker);
      count(emit("entry_range_reached", "info", `${w.ticker}: price entered your buy zone.`, w.ticker, ONCE));
    }
  }
  // activeSetups(), not raw trade_setups: archived (suppressed) pairs are
  // hidden from every other surface — the alert stream must respect the
  // archive too (roadmap #58).
  for (const s of activeSetups()) {
    if (s.setupQualityScore >= 7) {
      mark("new_setup", s.ticker);
      count(
        emit(
          "new_setup",
          "info",
          `${s.ticker}: ${s.setupType.replace(/_/g, " ")} setup (quality ${s.setupQualityScore.toFixed(1)}, R/R ${s.riskRewardRatio.toFixed(1)}:1).`,
          s.ticker,
          ONCE,
        ),
      );
    }
  }

  // --- Major catalysts ---
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const bigCatalysts = db
    .select()
    .from(schema.catalysts)
    .where(gte(schema.catalysts.discoveredAt, since))
    .all()
    .filter((c) => Math.abs(c.impactScore) >= 4);
  for (const c of bigCatalysts) {
    count(
      emit(
        "major_catalyst",
        c.impactScore < 0 ? "critical" : "warning",
        `${c.ticker ?? c.industry ?? "Market"}: major catalyst — ${c.title}`,
        c.ticker,
      ),
    );
  }

  // --- Stale data ---
  const tickers = new Set<string>([
    ...trades.map((t) => t.ticker),
    ...watch.map((w) => w.ticker),
  ]);
  const stale: { ticker: string; label: string }[] = [];
  for (const ticker of tickers) {
    const snap = getLatestSnapshot(ticker);
    const f = freshness(snap?.capturedAt ?? null, cfg.staleDataMinutes * 8);
    if (f.isStale) stale.push({ ticker, label: f.label });
  }
  // A majority-stale board is one fact, not N (roadmap #59): when the machine
  // wakes into a dead network every tracked ticker goes stale at once —
  // observed 2026-07-17: 52 warnings for a WiFi blip. Collapse the wave into
  // a single aggregate row (ticker null); below the threshold a stale ticker
  // is its own story (a delisted symbol, one broken transport) and stays
  // individually visible.
  if (stale.length >= STALE_WAVE_MIN && stale.length * 2 >= tickers.size) {
    mark("data_stale", null);
    count(
      emit(
        "data_stale",
        "warning",
        `${stale.length} of ${tickers.size} tracked tickers have stale market data — the refresh can't reach market data (network down or every quote provider failing). Recommendations may be outdated.`,
        null,
        ONCE,
      ),
    );
  } else {
    for (const { ticker, label } of stale) {
      mark("data_stale", ticker);
      count(
        emit("data_stale", "warning", `${ticker}: market data is ${label}. Recommendations may be outdated.`, ticker, ONCE),
      );
    }
  }

  // Close the loop (roadmap #49): condition alerts whose condition wasn't
  // seen this scan — including tickers no longer tracked — are auto-acked.
  ackClearedConditionAlerts(active);

  return created;
}

export interface AlertFilter {
  severity?: string; // info | warning | critical
  ticker?: string;
  acknowledged?: boolean;
}

/** Filtered alert history for the /alerts page (roadmap #27), newest first. */
export function listAlerts(filter: AlertFilter = {}, limit = 300) {
  const conds = [];
  if (filter.severity) conds.push(eq(schema.alerts.severity, filter.severity));
  if (filter.ticker) conds.push(eq(schema.alerts.ticker, filter.ticker.toUpperCase()));
  if (filter.acknowledged != null) conds.push(eq(schema.alerts.acknowledged, filter.acknowledged));
  const where = conds.length === 1 ? conds[0] : conds.length > 1 ? and(...conds) : undefined;
  const q = getDb().select().from(schema.alerts).orderBy(desc(schema.alerts.createdAt)).limit(limit);
  return where ? q.where(where).all() : q.all();
}

/** Distinct tickers that have ever raised an alert (for the filter dropdown). */
/**
 * Acknowledge every currently-unacknowledged alert matching the filter
 * (roadmap #35) — the bulk version of the per-row ack. Returns the count.
 */
export function ackAlerts(filter: Pick<AlertFilter, "severity" | "ticker"> = {}): number {
  const db = getDb();
  const conds = [eq(schema.alerts.acknowledged, false)];
  if (filter.severity) conds.push(eq(schema.alerts.severity, filter.severity));
  if (filter.ticker) conds.push(eq(schema.alerts.ticker, filter.ticker.toUpperCase()));
  const res = db
    .update(schema.alerts)
    .set({ acknowledged: true })
    .where(and(...conds))
    .run();
  return Number(res.changes);
}

export function alertTickers(): string[] {
  return [
    ...new Set(
      getDb()
        .select({ t: schema.alerts.ticker })
        .from(schema.alerts)
        .all()
        .map((r) => r.t)
        .filter((t): t is string => !!t),
    ),
  ].sort();
}

export function getRecentAlerts(limit = 50) {
  const db = getDb();
  return db
    .select()
    .from(schema.alerts)
    .orderBy(desc(schema.alerts.createdAt))
    .limit(limit)
    .all();
}
