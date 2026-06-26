import { NextResponse } from "next/server";
import { z } from "zod";
import { addEarningsReport, listEarnings } from "@/services/earnings";
import { recomputeStockAnalysis } from "@/services/marketData";

// Record a quarterly earnings result (actual vs estimate). On save we recompute
// the ticker's score so the beat/meet/miss weighs in immediately.

const earningsSchema = z.object({
  ticker: z.string().min(1).max(10),
  reportDate: z.string().min(8), // ISO date
  fiscalPeriod: z.string().max(40).nullish(),
  epsEstimate: z.coerce.number().nullish(),
  epsActual: z.coerce.number().nullish(),
  revenueEstimate: z.coerce.number().nullish(),
  revenueActual: z.coerce.number().nullish(),
  surprisePercent: z.coerce.number().min(-1000).max(10000).nullish(),
});

export function GET(req: Request) {
  const ticker = new URL(req.url).searchParams.get("ticker");
  if (!ticker) return NextResponse.json({ error: "ticker required" }, { status: 400 });
  return NextResponse.json(listEarnings(ticker));
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = earningsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;
  if (d.surprisePercent == null && (d.epsEstimate == null || d.epsActual == null)) {
    return NextResponse.json(
      { error: "Provide EPS estimate + actual, or a surprise %." },
      { status: 400 },
    );
  }
  const id = addEarningsReport(d);
  try {
    recomputeStockAnalysis(d.ticker.toUpperCase());
  } catch {
    // best effort — the score will catch up on the next refresh
  }
  return NextResponse.json({ ok: true, id });
}
