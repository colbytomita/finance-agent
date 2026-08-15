import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { AlpacaService } from "@/services/alpaca";
import { emitAlert } from "@/services/alerts";
import { closeTrade } from "@/services/trades";
import { exitTradeAtBroker, planExit } from "@/services/tradeExit";
import { errorMessage } from "@/lib/util";

// User-initiated exit: cancel the position's resting bracket legs, sell it at
// market, and record the close at the ACTUAL fill. Never runs on a schedule —
// the app does not exit positions on its own, the same rule that governs entry.

const exitSchema = z.object({
  // Required to be true to exit through a LIVE (real-money) account, mirroring
  // the confirmation that order placement already enforces.
  confirmLive: z.coerce.boolean().default(false),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const numId = parseInt(id, 10);
  if (!isFinite(numId)) return NextResponse.json({ error: "bad id" }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const parsed = exitSchema.safeParse(body ?? {});
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const db = getDb();
  const trade = db.select().from(schema.activeTrades).where(eq(schema.activeTrades.id, numId)).get();
  if (!trade) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (trade.status !== "open") {
    return NextResponse.json({ error: `This trade is already ${trade.status}.` }, { status: 400 });
  }

  const svc = AlpacaService.fromEnv();
  if (!svc) return NextResponse.json({ error: "Alpaca is not configured." }, { status: 400 });
  if (svc.mode === "live" && !parsed.data.confirmLive) {
    return NextResponse.json(
      { error: "This is a LIVE account — resubmit with confirmLive to sell real shares." },
      { status: 400 },
    );
  }

  try {
    const clock = await svc.getMarketClock();
    const plan = planExit(trade, { marketOpen: clock.isOpen });
    if (!plan.ok) return NextResponse.json({ error: plan.reason }, { status: 400 });

    const result = await exitTradeAtBroker(svc, trade, {
      closeTradeFn: ({ exitPrice, exitReason }) => closeTrade(trade, { exitPrice, exitReason }),
      onAlert: (severity, message) => emitAlert("trade_exit", severity, message, trade.ticker),
    });

    if (!result.ok) return NextResponse.json({ error: result.reason, ...result }, { status: 502 });
    return NextResponse.json({ ok: true, exitPrice: result.exitPrice, legsCancelled: result.legsCancelled });
  } catch (err) {
    return NextResponse.json({ error: errorMessage(err) }, { status: 502 });
  }
}
