import { NextResponse } from "next/server";
import { fetchEarningsForTickers } from "@/services/earnings";
import { getTrackedTickers, recomputeStockAnalysis } from "@/services/marketData";

// Auto-fetch earnings (estimate vs actual) from Yahoo for one ticker (body
// { ticker }) or all tracked tickers, then recompute so the beat/miss weighs in.
// Uses the headless browser, so allow a generous duration.
export const maxDuration = 300;

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const ticker = typeof body?.ticker === "string" && body.ticker.trim() ? body.ticker.trim().toUpperCase() : null;
  const tickers = ticker ? [ticker] : getTrackedTickers();
  if (tickers.length === 0) {
    return NextResponse.json({ error: "No tickers to fetch — add a watchlist/holding first." }, { status: 400 });
  }

  const result = await fetchEarningsForTickers(tickers);
  for (const t of tickers) {
    try {
      recomputeStockAnalysis(t);
    } catch {
      /* best effort */
    }
  }
  return NextResponse.json(result);
}
