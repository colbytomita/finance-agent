import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb, schema } from "@/db";

const holdingSchema = z.object({
  ticker: z.string().min(1).max(10),
  companyName: z.string().nullish(),
  shares: z.coerce.number().positive(),
  averageCost: z.coerce.number().positive(),
});

export async function GET() {
  const db = getDb();
  return NextResponse.json(db.select().from(schema.portfolioHoldings).all());
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = holdingSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;
  const db = getDb();
  const now = new Date().toISOString();
  const values = {
    ticker: d.ticker.toUpperCase(),
    companyName: d.companyName ?? null,
    shares: d.shares,
    averageCost: d.averageCost,
    source: "manual" as const,
    updatedAt: now,
  };
  db.insert(schema.portfolioHoldings)
    .values(values)
    .onConflictDoUpdate({ target: schema.portfolioHoldings.ticker, set: values })
    .run();
  return NextResponse.json({ ok: true });
}
