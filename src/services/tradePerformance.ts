import { closedTrades, journalEntries } from "@/lib/queries";

// Realized trade performance — what your *closed* trades actually did. Unlike the
// score/pick backtests (forward windows that need to mature), these are settled
// outcomes, so the numbers are usable immediately. Pure aggregation in
// `summarizeClosedTrades` (unit-tested); `getTradePerformance` wires up the reads.

export interface ClosedTradeInput {
  id: number;
  direction: string | null;
  entryPrice: number;
  exitPrice: number | null;
  stopLoss: number | null;
  entryDate: string | null;
  closedAt: string | null;
  unrealizedGainLoss: number | null; // realized $ at close
  unrealizedGainLossPercent: number | null; // realized % at close
}

export interface JournalInput {
  tradeId: number | null;
  profitLossPercent: number | null;
  holdingPeriodDays: number | null;
  // Stored with Drizzle boolean mode (integer 0/1 → boolean), so this reads back
  // as a real boolean, never the number 1 — compare against `true`, not `1`.
  thesisPlayedOut: boolean | null;
}

export interface TradeStats {
  closed: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRate: number | null; // % of closed trades with a positive P/L
  avgReturnPct: number | null; // mean realized % across trades (expectancy)
  avgWinPct: number | null;
  avgLossPct: number | null;
  profitFactor: number | null; // sum of winning $ / |sum of losing $|
  avgRMultiple: number | null; // mean (realized move / initial entry→stop risk)
  avgHoldingDays: number | null;
  thesisPlayedOutRate: number | null; // % of trades with a recorded outcome that played out
  totalPnl: number | null; // sum realized $
  bestPct: number | null;
  worstPct: number | null;
}

const mean = (xs: number[]): number | null => (xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Realized R-multiple (reward vs initial entry→stop risk). Null when undefined. */
export function tradeRMultiple(
  entryPrice: number,
  exitPrice: number | null,
  stopLoss: number | null,
  direction: string | null,
): number | null {
  if (exitPrice == null || stopLoss == null || !(entryPrice > 0) || !(stopLoss > 0) || stopLoss === entryPrice) {
    return null;
  }
  const dir = direction === "short" ? -1 : 1;
  const riskPerShare = Math.abs(entryPrice - stopLoss);
  if (!(riskPerShare > 0)) return null;
  return ((exitPrice - entryPrice) * dir) / riskPerShare;
}

/** Aggregate closed trades (+ their journal entries) into realized stats. Pure. */
export function summarizeClosedTrades(
  trades: ClosedTradeInput[],
  journal: JournalInput[],
): TradeStats {
  const journalByTrade = new Map<number, JournalInput>();
  for (const j of journal) if (j.tradeId != null) journalByTrade.set(j.tradeId, j);

  const empty: TradeStats = {
    closed: 0,
    wins: 0,
    losses: 0,
    breakeven: 0,
    winRate: null,
    avgReturnPct: null,
    avgWinPct: null,
    avgLossPct: null,
    profitFactor: null,
    avgRMultiple: null,
    avgHoldingDays: null,
    thesisPlayedOutRate: null,
    totalPnl: null,
    bestPct: null,
    worstPct: null,
  };
  if (trades.length === 0) return empty;

  const pcts: number[] = [];
  const winPcts: number[] = [];
  const lossPcts: number[] = [];
  const rMultiples: number[] = [];
  const holdingDays: number[] = [];
  let wins = 0;
  let losses = 0;
  let breakeven = 0;
  let winDollars = 0;
  let lossDollars = 0;
  let totalPnl = 0;
  let hasPnl = false;
  let thesisTrue = 0;
  let thesisTotal = 0;

  for (const t of trades) {
    const j = journalByTrade.get(t.id);
    const pct = t.unrealizedGainLossPercent ?? j?.profitLossPercent ?? null;
    const pnl = t.unrealizedGainLoss;
    const dir = t.direction === "short" ? -1 : 1;

    if (pct != null && isFinite(pct)) {
      pcts.push(pct);
      if (pct > 0) winPcts.push(pct);
      else if (pct < 0) lossPcts.push(pct);
    }

    // Win/loss classification by realized $ when available, else by %.
    const outcome = pnl != null && isFinite(pnl) ? pnl : pct;
    if (outcome != null && isFinite(outcome)) {
      if (outcome > 0) wins++;
      else if (outcome < 0) losses++;
      else breakeven++;
    } else {
      breakeven++;
    }

    if (pnl != null && isFinite(pnl)) {
      hasPnl = true;
      totalPnl += pnl;
      if (pnl > 0) winDollars += pnl;
      else if (pnl < 0) lossDollars += -pnl;
    }

    // R-multiple from the initial risk (entry → stop).
    if (
      t.exitPrice != null &&
      t.stopLoss != null &&
      t.entryPrice > 0 &&
      t.stopLoss > 0 &&
      t.stopLoss !== t.entryPrice
    ) {
      const riskPerShare = Math.abs(t.entryPrice - t.stopLoss);
      const rewardPerShare = (t.exitPrice - t.entryPrice) * dir;
      if (riskPerShare > 0) rMultiples.push(rewardPerShare / riskPerShare);
    }

    const hold =
      j?.holdingPeriodDays ??
      (t.entryDate && t.closedAt
        ? (Date.parse(t.closedAt) - Date.parse(t.entryDate)) / 86400000
        : null);
    if (hold != null && isFinite(hold)) holdingDays.push(hold);

    if (j?.thesisPlayedOut != null) {
      thesisTotal++;
      if (j.thesisPlayedOut === true) thesisTrue++;
    }
  }

  return {
    closed: trades.length,
    wins,
    losses,
    breakeven,
    winRate: (wins / trades.length) * 100,
    avgReturnPct: mean(pcts),
    avgWinPct: mean(winPcts),
    avgLossPct: mean(lossPcts),
    profitFactor: lossDollars > 0 ? winDollars / lossDollars : null,
    avgRMultiple: mean(rMultiples),
    avgHoldingDays: mean(holdingDays),
    thesisPlayedOutRate: thesisTotal > 0 ? (thesisTrue / thesisTotal) * 100 : null,
    totalPnl: hasPnl ? totalPnl : null,
    bestPct: pcts.length > 0 ? Math.max(...pcts) : null,
    worstPct: pcts.length > 0 ? Math.min(...pcts) : null,
  };
}

/** Realized stats over all closed trades in the DB. */
export function getTradePerformance(): TradeStats {
  return summarizeClosedTrades(closedTrades() as ClosedTradeInput[], journalEntries() as JournalInput[]);
}
