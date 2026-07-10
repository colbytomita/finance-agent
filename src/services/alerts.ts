import { and, desc, eq, gte, isNull } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { loadConfig } from "@/lib/config";
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

/** Scan current state and produce alerts. Returns number of new alerts. */
export function generateAlerts(): number {
  const db = getDb();
  const cfg = loadConfig();
  let created = 0;
  const count = (ok: boolean) => {
    if (ok) created++;
  };

  // --- Open trade alerts ---
  const trades = db
    .select()
    .from(schema.activeTrades)
    .where(eq(schema.activeTrades.status, "open"))
    .all();
  for (const t of trades) {
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
        count(
          emit("near_stop_loss", "warning", `${t.ticker}: within ${cfg.stopLossWarningPercent}% of stop-loss ${t.stopLoss}.`, t.ticker, ONCE),
        );
      }
    }
    if (t.targetPrice1 != null) {
      const hit = long ? price >= t.targetPrice1 : price <= t.targetPrice1;
      if (hit) {
        count(
          emit("target_hit", "info", `${t.ticker}: target 1 (${t.targetPrice1}) reached — trim rules apply.`, t.ticker, ONCE),
        );
      }
    }
    if (t.tradeScore != null && t.tradeScore < 3) {
      count(
        emit("trade_score_critical", "critical", `${t.ticker}: trade score ${t.tradeScore.toFixed(1)} — exit recommended.`, t.ticker, ONCE),
      );
    } else if (t.tradeScore != null && t.tradeScore < 5) {
      count(
        emit("trade_score_low", "warning", `${t.ticker}: trade score dropped to ${t.tradeScore.toFixed(1)} — monitor closely.`, t.ticker, ONCE),
      );
    }
    if (t.recommendation === "Exit") {
      count(emit("exit_recommended", "critical", `${t.ticker}: EXIT recommended.`, t.ticker, ONCE));
    } else if (t.recommendation === "Trim") {
      count(emit("trim_recommended", "warning", `${t.ticker}: trim recommended.`, t.ticker, ONCE));
    } else if (t.recommendation === "Add") {
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
      count(emit("entry_range_reached", "info", `${w.ticker}: price entered your buy zone.`, w.ticker, ONCE));
    }
  }
  const setups = db
    .select()
    .from(schema.tradeSetups)
    .where(eq(schema.tradeSetups.status, "active"))
    .all();
  for (const s of setups) {
    if (s.setupQualityScore >= 7) {
      count(
        emit(
          "new_setup",
          "info",
          `${s.ticker}: ${s.setupType.replace(/_/g, " ")} setup (quality ${s.setupQualityScore.toFixed(1)}, R/R ${s.riskRewardRatio.toFixed(1)}:1).`,
          s.ticker,
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
  for (const ticker of tickers) {
    const snap = getLatestSnapshot(ticker);
    const f = freshness(snap?.capturedAt ?? null, cfg.staleDataMinutes * 8);
    if (f.isStale) {
      count(
        emit("data_stale", "warning", `${ticker}: market data is ${f.label}. Recommendations may be outdated.`, ticker, ONCE),
      );
    }
  }

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
