import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";

const patchSchema = z.object({
  action: z.enum(["update", "close", "invalidate"]),
  stopLoss: z.coerce.number().positive().nullish(),
  targetPrice1: z.coerce.number().positive().nullish(),
  targetPrice2: z.coerce.number().positive().nullish(),
  thesis: z.string().nullish(),
  invalidationReason: z.string().nullish(),
  // close fields
  exitPrice: z.coerce.number().positive().nullish(),
  exitReason: z.string().nullish(),
  lessons: z.string().nullish(),
  mistakes: z.string().nullish(),
  thesisPlayedOut: z.coerce.boolean().nullish(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const numId = parseInt(id, 10);
  if (!isFinite(numId)) return NextResponse.json({ error: "bad id" }, { status: 400 });

  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;
  const db = getDb();
  const trade = db
    .select()
    .from(schema.activeTrades)
    .where(eq(schema.activeTrades.id, numId))
    .get();
  if (!trade) return NextResponse.json({ error: "not found" }, { status: 404 });
  const now = new Date().toISOString();

  if (d.action === "update") {
    db.update(schema.activeTrades)
      .set({
        stopLoss: d.stopLoss !== undefined ? d.stopLoss : trade.stopLoss,
        targetPrice1: d.targetPrice1 !== undefined ? d.targetPrice1 : trade.targetPrice1,
        targetPrice2: d.targetPrice2 !== undefined ? d.targetPrice2 : trade.targetPrice2,
        thesis: d.thesis !== undefined ? d.thesis : trade.thesis,
        updatedAt: now,
      })
      .where(eq(schema.activeTrades.id, numId))
      .run();
    return NextResponse.json({ ok: true });
  }

  if (d.action === "invalidate") {
    db.update(schema.activeTrades)
      .set({ invalidationReason: d.invalidationReason ?? "Thesis invalidated", updatedAt: now })
      .where(eq(schema.activeTrades.id, numId))
      .run();
    return NextResponse.json({ ok: true });
  }

  // close: record exit + auto-create journal entry
  const exitPrice = d.exitPrice ?? trade.currentPrice ?? trade.entryPrice;
  const dirMult = trade.direction === "short" ? -1 : 1;
  const profitLoss = (exitPrice - trade.entryPrice) * trade.shares * dirMult;
  const profitLossPercent =
    trade.entryPrice > 0 ? ((exitPrice - trade.entryPrice) / trade.entryPrice) * 100 * dirMult : null;
  const holdingDays = (Date.now() - new Date(trade.entryDate).getTime()) / 86400000;

  db.update(schema.activeTrades)
    .set({
      status: "closed",
      closedAt: now,
      exitPrice,
      currentPrice: exitPrice,
      unrealizedGainLoss: profitLoss,
      unrealizedGainLossPercent: profitLossPercent,
      updatedAt: now,
    })
    .where(eq(schema.activeTrades.id, numId))
    .run();

  db.insert(schema.tradeJournalEntries)
    .values({
      tradeId: trade.id,
      ticker: trade.ticker,
      entryReason: trade.thesis,
      entryScore: null,
      exitReason: d.exitReason ?? null,
      exitScore: trade.tradeScore,
      profitLoss,
      profitLossPercent,
      holdingPeriodDays: Math.round(holdingDays * 10) / 10,
      mistakes: d.mistakes ?? null,
      lessons: d.lessons ?? null,
      catalystImpact: null,
      thesisPlayedOut: d.thesisPlayedOut ?? null,
      createdAt: now,
    })
    .run();

  return NextResponse.json({ ok: true, profitLoss, profitLossPercent });
}
