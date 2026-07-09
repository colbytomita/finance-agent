import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { nowIso } from "@/lib/util";
import { pretradeRiskProblems } from "@/services/trades";

const tradeSchema = z.object({
  ticker: z.string().min(1).max(10),
  direction: z.enum(["long", "short"]).default("long"),
  entryPrice: z.coerce.number().positive(),
  entryDate: z.string().optional(),
  shares: z.coerce.number().positive(),
  stopLoss: z.coerce.number().positive().nullish(),
  targetPrice1: z.coerce.number().positive().nullish(),
  targetPrice2: z.coerce.number().positive().nullish(),
  thesis: z.string().nullish(),
  // Required to be true to log a trade that fails the pre-trade risk checks
  // (no stop, thin R/R, inside the earnings-avoidance window).
  confirmRisks: z.coerce.boolean().default(false),
});

export async function GET() {
  const db = getDb();
  return NextResponse.json(db.select().from(schema.activeTrades).all());
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = tradeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;
  // Sanity-check stop placement so bad data doesn't poison the scoring.
  if (d.stopLoss != null) {
    const wrongSide =
      d.direction === "long" ? d.stopLoss >= d.entryPrice : d.stopLoss <= d.entryPrice;
    if (wrongSide) {
      return NextResponse.json(
        { error: "Stop-loss must be on the losing side of entry." },
        { status: 400 },
      );
    }
  }
  // Pre-trade risk gate (roadmap #29): a speed bump, not a hard block — the
  // same problems logged with confirmRisks acknowledge them and proceed.
  const riskProblems = pretradeRiskProblems({
    ticker: d.ticker,
    direction: d.direction,
    entry: d.entryPrice,
    stop: d.stopLoss ?? null,
    target: d.targetPrice1 ?? null,
  });
  if (riskProblems.length > 0 && !d.confirmRisks) {
    return NextResponse.json(
      {
        error: `Risk check: ${riskProblems.join(" ")}`,
        riskProblems,
      },
      { status: 400 },
    );
  }
  const db = getDb();
  const now = nowIso();
  db.insert(schema.activeTrades)
    .values({
      ticker: d.ticker.toUpperCase(),
      direction: d.direction,
      entryPrice: d.entryPrice,
      entryDate: d.entryDate ?? now,
      shares: d.shares,
      positionSize: d.shares * d.entryPrice,
      stopLoss: d.stopLoss ?? null,
      targetPrice1: d.targetPrice1 ?? null,
      targetPrice2: d.targetPrice2 ?? null,
      currentPrice: d.entryPrice,
      thesis: d.thesis ?? null,
      status: "open",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return NextResponse.json({ ok: true });
}
