import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { AlpacaService } from "@/services/alpaca";
import { restoreStopRequest } from "@/services/stopCoverage";
import { errorMessage } from "@/lib/util";

// Re-place a trade's protective stop at the broker when the reconciliation check
// (roadmap #75) finds the recorded stop has no live order behind it. Strictly
// user-initiated: the app surfaces the gap, the user decides to close it. It
// never places orders on its own.

const schemaBody = z.object({ confirmLive: z.coerce.boolean().default(false) });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const numId = parseInt(id, 10);
  if (!isFinite(numId)) return NextResponse.json({ error: "bad id" }, { status: 400 });

  const parsed = schemaBody.safeParse((await req.json().catch(() => ({}))) ?? {});
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const db = getDb();
  const trade = db.select().from(schema.activeTrades).where(eq(schema.activeTrades.id, numId)).get();
  if (!trade) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (trade.status !== "open") {
    return NextResponse.json({ error: `This trade is ${trade.status}.` }, { status: 400 });
  }
  if (trade.stopLoss == null) {
    return NextResponse.json(
      { error: "This trade has no stop recorded — set one on the trade first." },
      { status: 400 },
    );
  }

  const svc = AlpacaService.fromEnv();
  if (!svc) return NextResponse.json({ error: "Alpaca is not configured." }, { status: 400 });
  if (svc.mode === "live" && !parsed.data.confirmLive) {
    return NextResponse.json(
      { error: "This is a LIVE account — resubmit with confirmLive to place a real order." },
      { status: 400 },
    );
  }

  try {
    // Guard against double-placing: if a stop is already working, do nothing.
    const existing = await svc.openOrdersFor(trade.ticker);
    const wantSide = trade.direction === "short" ? "buy" : "sell";
    if (existing.some((o) => o.type.includes("stop") && o.side === wantSide)) {
      return NextResponse.json({ ok: true, alreadyProtected: true });
    }

    const order = await svc.placeOrder(restoreStopRequest(trade));
    return NextResponse.json({ ok: true, orderId: order.id, stopPrice: trade.stopLoss });
  } catch (err) {
    return NextResponse.json({ error: errorMessage(err) }, { status: 502 });
  }
}
