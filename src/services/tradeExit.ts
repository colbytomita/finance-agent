import type { AlpacaOrder, AlpacaOrderRequest, AlpacaService } from "./alpaca";
import type { CloseTradeResult } from "./trades";

// Exiting a position at the broker, safely.
//
// This is deliberately more than "send a sell". Trades placed with a protective
// stop and/or target are BRACKET orders: their legs rest at Alpaca as live
// orders against the same shares. Selling underneath them either gets rejected
// for insufficient quantity or fills and leaves an orphaned stop that can later
// execute and flip the account short. So an exit is: cancel the legs, sell, wait
// for a real fill, then record the close at the price actually paid.
//
// The dangerous window is between the cancel and the fill — the position is
// briefly unprotected. If the sell fails there, we put the stop back rather than
// leaving the user worse off than before they pressed the button.
//
// User-initiated only. Nothing here runs on a schedule.

/** Terminal states for the closing order (mirrors orderSync's set). */
const FILLED_STATUSES = new Set(["filled"]);
const DEAD_STATUSES = new Set(["canceled", "cancelled", "expired", "rejected"]);

export interface ExitableTrade {
  id: number;
  ticker: string;
  direction: string | null;
  shares: number;
  stopLoss: number | null;
  targetPrice1?: number | null;
  /** Present for tracked trades; absent for a bare portfolio holding. */
  broker?: string | null;
  brokerOrderId?: string | null;
}

/**
 * The closing order. A long is flattened by selling, a short by buying back, and
 * it carries NO protective legs — a bracket on the exit would open a fresh
 * protected position in the opposite direction instead of flattening this one.
 */
export function exitOrderRequest(trade: ExitableTrade): AlpacaOrderRequest {
  return {
    symbol: trade.ticker.toUpperCase(),
    qty: trade.shares,
    side: trade.direction === "short" ? "buy" : "sell",
    type: "market",
    timeInForce: "day",
    limitPrice: null,
    stopLoss: null,
    takeProfit: null,
  };
}

export interface ExitPlan {
  ok: boolean;
  reason?: string;
}

/**
 * Pre-flight checks, pure so they can be unit-tested and so the UI can explain a
 * refusal without touching the broker.
 */
export function planExit(trade: ExitableTrade, ctx: { marketOpen: boolean }): ExitPlan {
  if (!trade.broker || !trade.brokerOrderId) {
    return { ok: false, reason: "This trade is not linked to a broker order — close it manually instead." };
  }
  if (!(trade.shares > 0)) {
    return { ok: false, reason: "This trade has no share count to sell." };
  }
  if (!ctx.marketOpen) {
    // A market order placed out of hours queues until the open, so the fill
    // price is unknown and the position would sit unprotected overnight with its
    // bracket legs already cancelled. Refuse rather than take that risk.
    return { ok: false, reason: "The market is closed — a market exit would queue unfilled. Try again during market hours." };
  }
  return { ok: true };
}

/**
 * Pre-flight for exiting a bare portfolio HOLDING. Holdings arrive from the
 * broker sync, so unlike a tracked trade there is no order to have been linked
 * to — but there may also be no trade record to close, in which case the sell is
 * reconciled by the next portfolio sync rather than by `closeTrade`.
 */
export function planHoldingExit(
  holding: { ticker: string; shares: number },
  ctx: { marketOpen: boolean },
): ExitPlan {
  if (!(holding.shares > 0)) return { ok: false, reason: "This holding has no shares to sell." };
  if (!ctx.marketOpen) {
    return { ok: false, reason: "The market is closed — a market exit would queue unfilled. Try again during market hours." };
  }
  return { ok: true };
}

export interface ExitResult {
  ok: boolean;
  exitPrice?: number;
  pending?: boolean;
  stopRestored?: boolean;
  reason?: string;
  legsCancelled?: number;
}

export interface ExitOptions {
  closeTradeFn: (opts: { exitPrice: number; exitReason: string }) => CloseTradeResult | unknown;
  onAlert: (severity: "critical" | "warning" | "info", message: string) => void;
  sleepFn?: (ms: number) => Promise<void>;
  maxPolls?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Cancel resting legs → market close the position → wait for a real fill →
 * record the close at the actual fill price.
 */
export async function exitTradeAtBroker(
  svc: AlpacaService,
  trade: ExitableTrade,
  opts: ExitOptions,
): Promise<ExitResult> {
  const sleep = opts.sleepFn ?? defaultSleep;
  const maxPolls = opts.maxPolls ?? 12;

  // 1. Clear the protective legs so the shares are free to sell.
  const open = await svc.openOrdersFor(trade.ticker);
  for (const leg of open) await svc.cancelOrder(leg.id);

  // 2. Flatten the position.
  let placed: AlpacaOrder;
  try {
    placed = await svc.placeOrder(exitOrderRequest(trade));
  } catch (err) {
    // The legs are gone and the sell failed: the position is now UNPROTECTED,
    // which is strictly worse than before. Put the stop back and say so loudly.
    let stopRestored = false;
    if (trade.stopLoss != null && open.length > 0) {
      try {
        await svc.placeOrder({
          symbol: trade.ticker.toUpperCase(),
          qty: trade.shares,
          side: trade.direction === "short" ? "buy" : "sell",
          type: "stop",
          timeInForce: "gtc",
          limitPrice: null,
          stopPrice: trade.stopLoss,
          stopLoss: null,
          takeProfit: null,
        });
        stopRestored = true;
      } catch {
        /* fall through — the alert below is the backstop */
      }
    }
    const detail = stopRestored
      ? "its protective stop was re-placed"
      : "ITS PROTECTIVE STOP COULD NOT BE RE-PLACED — the position is unprotected";
    opts.onAlert(
      "critical",
      `Exit of ${trade.ticker} failed after cancelling its bracket legs; ${detail}. Broker said: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { ok: false, stopRestored, legsCancelled: open.length, reason: `Exit order rejected: ${err instanceof Error ? err.message : String(err)}` };
  }

  // 3. Wait for a real fill. Closing on an unfilled order would record a
  //    fictional exit price and corrupt the realized-performance stats.
  let latest: AlpacaOrder = placed;
  for (let i = 0; i < maxPolls; i++) {
    latest = await svc.getOrder(placed.id);
    if (FILLED_STATUSES.has(latest.status) || DEAD_STATUSES.has(latest.status)) break;
    await sleep(1000);
  }

  if (!FILLED_STATUSES.has(latest.status) || latest.filledAvgPrice == null) {
    const dead = DEAD_STATUSES.has(latest.status);
    opts.onAlert(
      dead ? "critical" : "warning",
      `Exit order for ${trade.ticker} is ${latest.status} — the trade is still open and its bracket legs were cancelled. Check the position at your broker.`,
    );
    return {
      ok: false,
      pending: !dead,
      legsCancelled: open.length,
      reason: dead
        ? `The exit order was ${latest.status}.`
        : "The exit order has not filled yet — the trade stays open until it does.",
    };
  }

  // 4. Record the close at the price actually paid.
  opts.closeTradeFn({ exitPrice: latest.filledAvgPrice, exitReason: "Exited at market from the app" });
  return { ok: true, exitPrice: latest.filledAvgPrice, legsCancelled: open.length };
}
