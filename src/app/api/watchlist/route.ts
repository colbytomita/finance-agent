import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb, schema } from "@/db";

const upsertSchema = z.object({
  ticker: z.string().min(1).max(10),
  companyName: z.string().nullish(),
  targetBuyLow: z.coerce.number().positive().nullish(),
  targetBuyHigh: z.coerce.number().positive().nullish(),
  reinvestAbovePrice: z.coerce.number().positive().nullish(),
  maxRiskPrice: z.coerce.number().positive().nullish(),
  maxPortfolioWeight: z.coerce.number().min(0).max(100).nullish(),
  notes: z.string().nullish(),
});

export async function GET() {
  const db = getDb();
  return NextResponse.json(db.select().from(schema.watchlistItems).all());
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = upsertSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;
  if (d.targetBuyLow != null && d.targetBuyHigh != null && d.targetBuyLow > d.targetBuyHigh) {
    return NextResponse.json(
      { error: "targetBuyLow must be ≤ targetBuyHigh" },
      { status: 400 },
    );
  }
  const db = getDb();
  const now = new Date().toISOString();
  const values = {
    ticker: d.ticker.toUpperCase(),
    companyName: d.companyName ?? null,
    targetBuyLow: d.targetBuyLow ?? null,
    targetBuyHigh: d.targetBuyHigh ?? null,
    reinvestAbovePrice: d.reinvestAbovePrice ?? null,
    maxRiskPrice: d.maxRiskPrice ?? null,
    maxPortfolioWeight: d.maxPortfolioWeight ?? null,
    notes: d.notes ?? null,
    updatedAt: now,
  };
  db.insert(schema.watchlistItems)
    .values({ ...values, createdAt: now })
    .onConflictDoUpdate({ target: schema.watchlistItems.ticker, set: values })
    .run();
  return NextResponse.json({ ok: true });
}
