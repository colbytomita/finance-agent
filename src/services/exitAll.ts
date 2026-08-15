import type { AlpacaService } from "./alpaca";
import { exitTradeAtBroker, type ExitableTrade, type ExitResult } from "./tradeExit";

// Bulk exit — close every open position in one reviewed action (roadmap #76).
//
// Deliberately conservative, because this sends a lot of real orders at once:
//   * ONE market-open check up front; if the market is shut nothing is attempted
//     at all (a queued market order would leave positions unprotected with their
//     bracket legs already cancelled).
//   * SEQUENTIAL, never parallel. Overlapping cancel/sell cycles against the same
//     account invite rejections and make a partial failure hard to reason about.
//   * A failure NEVER aborts the batch. The entire point is not to strand the
//     remaining positions half-exited — each result is reported individually.
//
// User-initiated only, behind a type-to-confirm gate in the UI.

export interface BulkExitTarget extends ExitableTrade {}

export interface BulkExitRow {
  tradeId: number;
  ticker: string;
  shares: number;
  ok: boolean;
  exitPrice?: number;
  reason?: string;
  skipped?: boolean;
}

export interface BulkExitResult {
  refused: boolean;
  refusedReason?: string;
  results: BulkExitRow[];
  succeeded: number;
  failed: number;
}

export interface BulkExitOptions {
  marketOpen: boolean;
  onAlert: (severity: "critical" | "warning" | "info", message: string) => void;
  /** Injected so the batching logic is testable without a broker. */
  exitOne: (svc: AlpacaService, trade: BulkExitTarget) => Promise<ExitResult>;
}

export async function exitAllPositions(
  svc: AlpacaService,
  targets: BulkExitTarget[],
  opts: BulkExitOptions,
): Promise<BulkExitResult> {
  if (!opts.marketOpen) {
    return {
      refused: true,
      refusedReason:
        "The market is closed — a market exit would queue unfilled. Run this during market hours.",
      results: [],
      succeeded: 0,
      failed: 0,
    };
  }

  const results: BulkExitRow[] = [];
  for (const t of targets) {
    if (!(t.shares > 0)) {
      results.push({ tradeId: t.id, ticker: t.ticker, shares: t.shares, ok: false, skipped: true, reason: "No shares to sell." });
      continue;
    }
    try {
      const r = await opts.exitOne(svc, t);
      results.push({
        tradeId: t.id,
        ticker: t.ticker,
        shares: t.shares,
        ok: r.ok,
        exitPrice: r.exitPrice,
        reason: r.ok ? undefined : r.reason,
      });
    } catch (err) {
      // Keep going — a thrown error on one position must not strand the rest.
      results.push({
        tradeId: t.id,
        ticker: t.ticker,
        shares: t.shares,
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const failedRows = results.filter((r) => !r.ok && !r.skipped);
  if (failedRows.length > 0) {
    opts.onAlert(
      "critical",
      `Bulk exit: ${failedRows.length} of ${results.length} position(s) did NOT exit — ` +
        `${failedRows.map((r) => r.ticker).join(", ")}. Check these at your broker; their bracket legs may already be cancelled.`,
    );
  }

  return {
    refused: false,
    results,
    succeeded: results.filter((r) => r.ok).length,
    failed: failedRows.length,
  };
}

/** Default wiring for production use. */
export const defaultExitOne = (
  svc: AlpacaService,
  trade: BulkExitTarget,
  closeTradeFn: BulkExitCloseFn,
  onAlert: BulkExitOptions["onAlert"],
): Promise<ExitResult> =>
  exitTradeAtBroker(svc, trade, { closeTradeFn: (o) => closeTradeFn(trade, o), onAlert });

export type BulkExitCloseFn = (
  trade: BulkExitTarget,
  opts: { exitPrice: number; exitReason: string },
) => unknown;
