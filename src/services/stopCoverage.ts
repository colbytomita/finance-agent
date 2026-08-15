import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { errorMessage } from "@/lib/util";
import { AlpacaService, type AlpacaOrderRequest } from "./alpaca";
import { emitAlert } from "./alerts";

// Stop-coverage reconciliation (roadmap #75).
//
// The app records the stop it INTENDED for each trade, but the only authority on
// what protection actually exists is the broker. Those two drifted apart without
// anything noticing: an audit of the live account found 5 of 11 positions with no
// working stop order at all, ~$5,965 exposed. Three causes, only one a defect:
//   1. OCO — a bracket's legs are a pair, so a filled stop cancels its target and
//      vice versa. Normal, and those trades are closed anyway.
//   2. `time_in_force=day` on early orders, whose protective legs expired at that
//      day's close and were never replaced.
//   3. Broker-side cancellation with neither leg filled and the position still
//      open (QBTS, 2026-07-27). Unexplained — exactly what needs surfacing.
//
// Detection only. This module never places an order; restoring a stop is a
// user-initiated action, consistent with the app never trading on its own.

/** Order statuses that still represent working protection at the broker. */
const LIVE_STATUSES = new Set(["new", "accepted", "held", "partially_filled", "pending_new"]);

export interface CoverageTrade {
  id: number;
  ticker: string;
  direction: string | null;
  shares: number;
  stopLoss: number | null;
  broker: string | null;
}

/** The shape we need from a broker order — kept minimal so this stays pure. */
export interface CoverageOrder {
  type: string;
  side: string;
  status: string;
}

export type StopGapKind =
  /** A stop is recorded on the trade but no live stop order exists. Restorable. */
  | "missing_at_broker"
  /** The trade never had a stop recorded, so there is nothing to restore. */
  | "no_stop_defined";

export interface StopGap {
  tradeId: number;
  ticker: string;
  shares: number;
  recordedStop: number | null;
  kind: StopGapKind;
}

/** The side that CLOSES the position — a long is stopped by selling, a short by buying. */
const closingSide = (direction: string | null): "buy" | "sell" => (direction === "short" ? "buy" : "sell");

/**
 * Compare each open trade's intended stop against the orders actually working at
 * the broker. Pure: callers supply the live orders per ticker.
 */
export function findStopGaps(
  trades: CoverageTrade[],
  liveOrdersByTicker: Map<string, CoverageOrder[]>,
): StopGap[] {
  const gaps: StopGap[] = [];
  for (const t of trades) {
    // A manually logged trade has no broker orders by definition; flagging it
    // would be noise the user cannot act on.
    if (!t.broker) continue;

    const orders = liveOrdersByTicker.get(t.ticker.toUpperCase()) ?? [];
    const want = closingSide(t.direction);
    const hasLiveStop = orders.some(
      (o) =>
        LIVE_STATUSES.has(o.status) &&
        (o.type === "stop" || o.type === "stop_limit" || o.type === "trailing_stop") &&
        o.side === want,
    );
    if (hasLiveStop) continue;

    gaps.push({
      tradeId: t.id,
      ticker: t.ticker,
      shares: t.shares,
      recordedStop: t.stopLoss,
      kind: t.stopLoss != null ? "missing_at_broker" : "no_stop_defined",
    });
  }
  return gaps;
}

/**
 * The order that restores a trade's protective stop: a standalone GTC stop for
 * the full position on the closing side. GTC deliberately — the legs that went
 * missing on 2026-06-25 were `day` orders that expired at that day's close.
 */
export function restoreStopRequest(trade: CoverageTrade): AlpacaOrderRequest {
  if (trade.stopLoss == null) {
    throw new Error(`${trade.ticker} has no recorded stop to restore.`);
  }
  return {
    symbol: trade.ticker.toUpperCase(),
    qty: trade.shares,
    side: closingSide(trade.direction),
    type: "stop",
    timeInForce: "gtc",
    stopPrice: trade.stopLoss,
    limitPrice: null,
    stopLoss: null,
    takeProfit: null,
  };
}

export interface StopCoverageResult {
  checked: number;
  gaps: StopGap[];
  errors: string[];
}

/**
 * Read every open broker-linked trade, ask the broker what protection is
 * actually working for each ticker, and raise an alert per gap. Runs inside the
 * normal refresh/maintenance path. Emits only — it never places an order.
 */
export async function checkStopCoverage(
  alpaca: AlpacaService | null = AlpacaService.fromEnv(),
): Promise<StopCoverageResult> {
  const result: StopCoverageResult = { checked: 0, gaps: [], errors: [] };
  if (!alpaca) return result;

  const db = getDb();
  const trades = db
    .select()
    .from(schema.activeTrades)
    .where(eq(schema.activeTrades.status, "open"))
    .all()
    .filter((t) => t.broker) as CoverageTrade[];
  if (trades.length === 0) return result;

  // ONE request for the whole account, then group locally — this runs on every
  // refresh, so a call per ticker would be wasteful. `workingOrders` filters to
  // live statuses INCLUDING `held`, which is where a bracket's protective stop
  // sits and which Alpaca's own `?status=open` omits.
  let working;
  try {
    working = await alpaca.workingOrders();
  } catch (err) {
    // If the broker cannot be read, report NOTHING as unprotected — a network
    // blip must not raise a critical "your position is naked" false alarm.
    result.errors.push(errorMessage(err));
    return result;
  }

  const byTicker = new Map<string, CoverageOrder[]>();
  for (const t of trades) byTicker.set(t.ticker.toUpperCase(), []);
  for (const o of working) {
    const key = o.symbol.toUpperCase();
    if (byTicker.has(key)) byTicker.get(key)!.push({ type: o.type, side: o.side, status: o.status });
  }

  result.checked = byTicker.size;
  result.gaps = findStopGaps(trades, byTicker);

  for (const gap of result.gaps) {
    emitAlert(
      "stop_missing",
      gap.kind === "missing_at_broker" ? "critical" : "warning",
      describeGap(gap),
      gap.ticker,
      { onceWhileUnacked: true },
    );
  }
  return result;
}

/** One-line summary for an alert / the status page. */
export function describeGap(gap: StopGap): string {
  return gap.kind === "missing_at_broker"
    ? `${gap.ticker}: ${gap.shares} shares have NO stop order at the broker (recorded stop ${gap.recordedStop}). The position is unprotected.`
    : `${gap.ticker}: ${gap.shares} shares have no stop at the broker and none recorded on the trade.`;
}
