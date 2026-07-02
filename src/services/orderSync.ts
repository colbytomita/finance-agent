import { and, eq, isNotNull, like } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { errorMessage, nowIso } from "@/lib/util";
import { AlpacaService, type AlpacaOrder } from "./alpaca";
import { emitAlert } from "./alerts";

// Broker order-fill sync. Placing an order logs a trade immediately with the
// intended entry (limit/reference price) and stores the Alpaca order id — but
// until now nothing ever read the order back. A limit that never fills, gets
// canceled, or part-fills left a phantom "open" trade with wrong entry data,
// which then fed trade scores and realized-performance stats. This module polls
// each open broker trade's order and reconciles the trade row with reality:
//
//   filled            -> correct entryPrice/shares to the actual fill
//   partially_filled  -> track the partial fill (keeps polling)
//   canceled/expired/
//   rejected (no fill)-> mark the trade "canceled" (never happened)
//   ...with a fill    -> keep the filled portion as the position
//   replaced          -> flag for manual follow-up (we can't track the new id)
//
// The pure decision lives in planOrderSync (unit-tested); IO stays thin.

/** Order statuses after which the order can never change again — stop polling. */
export const TERMINAL_ORDER_STATUSES = new Set([
  "filled",
  "canceled",
  "expired",
  "rejected",
  "replaced",
]);

export type OrderSyncAction =
  /** Nothing new — same status as last time, no fill data to record. */
  | { kind: "none" }
  /** Record the order status on the trade; no trade fields change. */
  | { kind: "status"; orderStatus: string }
  /** Reconcile the trade with fill data (entry price and/or share count). */
  | { kind: "fill"; orderStatus: string; entryPrice: number; shares: number }
  /** The order died with nothing filled — the trade never happened. */
  | { kind: "cancel"; orderStatus: string }
  /** Order was replaced outside the app; the new order id is unknown to us. */
  | { kind: "orphaned"; orderStatus: string };

export interface SyncableTrade {
  entryPrice: number;
  shares: number;
  brokerOrderStatus: string | null;
}

const differs = (a: number, b: number) => Math.abs(a - b) > 1e-9;

/**
 * Decide how a trade row should change given its broker order's current state.
 * Pure — no IO, no dates — so every branch is unit-testable.
 */
export function planOrderSync(trade: SyncableTrade, order: AlpacaOrder): OrderSyncAction {
  const status = order.status;
  const fillPrice = order.filledAvgPrice;
  const fillQty = order.filledQty;
  const hasFill = fillQty != null && fillQty > 0 && fillPrice != null;

  if (status === "replaced") return { kind: "orphaned", orderStatus: status };

  // Dead order, nothing executed: the logged trade is a phantom.
  if ((status === "canceled" || status === "expired" || status === "rejected") && !hasFill) {
    return { kind: "cancel", orderStatus: status };
  }

  // Any fill data (full, partial, or the filled part of a dead order): make the
  // trade row match what actually executed.
  if (hasFill && (differs(fillPrice, trade.entryPrice) || differs(fillQty, trade.shares))) {
    return { kind: "fill", orderStatus: status, entryPrice: fillPrice, shares: fillQty };
  }

  // Nothing to reconcile — record the status when it changed (also how terminal
  // orders with already-correct values stop being polled).
  return trade.brokerOrderStatus === status ? { kind: "none" } : { kind: "status", orderStatus: status };
}

export interface OrderSyncResult {
  checked: number;
  corrected: number; // trades whose entry/shares were reconciled to fill data
  canceled: number; // phantom trades removed from the open list
  flagged: number; // replaced orders needing manual follow-up
  errors: string[];
}

/**
 * Poll every open broker-placed trade whose order isn't in a terminal state and
 * apply the planned reconciliation. Cheap: normally zero or a handful of rows.
 */
export async function syncBrokerOrders(
  alpaca: AlpacaService | null = AlpacaService.fromEnv(),
): Promise<OrderSyncResult> {
  const result: OrderSyncResult = { checked: 0, corrected: 0, canceled: 0, flagged: 0, errors: [] };
  if (!alpaca) return result;

  const db = getDb();
  const trades = db
    .select()
    .from(schema.activeTrades)
    .where(
      and(
        eq(schema.activeTrades.status, "open"),
        like(schema.activeTrades.broker, "alpaca%"),
        isNotNull(schema.activeTrades.brokerOrderId),
      ),
    )
    .all()
    .filter((t) => t.brokerOrderStatus == null || !TERMINAL_ORDER_STATUSES.has(t.brokerOrderStatus));

  for (const t of trades) {
    result.checked++;
    try {
      const order = await alpaca.getOrder(t.brokerOrderId as string);
      const action = planOrderSync(t, order);
      const now = nowIso();

      switch (action.kind) {
        case "none":
          break;
        case "status":
          db.update(schema.activeTrades)
            .set({ brokerOrderStatus: action.orderStatus, updatedAt: now })
            .where(eq(schema.activeTrades.id, t.id))
            .run();
          break;
        case "fill": {
          db.update(schema.activeTrades)
            .set({
              entryPrice: action.entryPrice,
              shares: action.shares,
              positionSize: action.entryPrice * action.shares,
              brokerOrderStatus: action.orderStatus,
              updatedAt: now,
            })
            .where(eq(schema.activeTrades.id, t.id))
            .run();
          result.corrected++;
          emitAlert(
            "order_fill",
            "info",
            `${t.ticker}: order ${action.orderStatus} — ${action.shares} share(s) at ${action.entryPrice.toFixed(2)} ` +
              `(trade corrected from ${t.shares} at ${t.entryPrice.toFixed(2)}).`,
            t.ticker,
          );
          break;
        }
        case "cancel":
          db.update(schema.activeTrades)
            .set({
              status: "canceled",
              closedAt: now,
              brokerOrderStatus: action.orderStatus,
              invalidationReason: `Broker order ${action.orderStatus} with no fill`,
              updatedAt: now,
            })
            .where(eq(schema.activeTrades.id, t.id))
            .run();
          result.canceled++;
          emitAlert(
            "order_canceled",
            "warning",
            `${t.ticker}: order ${action.orderStatus} with nothing filled — the logged trade was removed from open trades.`,
            t.ticker,
          );
          break;
        case "orphaned":
          db.update(schema.activeTrades)
            .set({ brokerOrderStatus: action.orderStatus, updatedAt: now })
            .where(eq(schema.activeTrades.id, t.id))
            .run();
          result.flagged++;
          emitAlert(
            "order_replaced",
            "warning",
            `${t.ticker}: order was replaced outside the app — its fills can't be tracked. Verify the trade's entry/size manually.`,
            t.ticker,
          );
          break;
      }
    } catch (e) {
      result.errors.push(`${t.ticker} (${t.brokerOrderId}): ${errorMessage(e)}`);
    }
  }
  return result;
}
