import { NextResponse } from "next/server";
import { readCachedReport, runPerformanceBacktest } from "@/services/signalPerformance";
import { getTradePerformance } from "@/services/tradePerformance";
import { errorMessage } from "@/lib/util";

export const maxDuration = 300;

export async function GET() {
  return NextResponse.json({ report: readCachedReport(), trades: getTradePerformance() });
}

export async function POST() {
  try {
    const report = await runPerformanceBacktest();
    return NextResponse.json({ ...report, trades: getTradePerformance() });
  } catch (e) {
    return NextResponse.json(
      { error: errorMessage(e) },
      { status: 500 },
    );
  }
}
