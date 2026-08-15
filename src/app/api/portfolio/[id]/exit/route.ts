import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { AlpacaService } from "@/services/alpaca";
import { emitAlert } from "@/services/alerts";
import { closeTrade } from "@/services/trades";
import { exitTradeAtBroker, planHoldingExit } from "@/services/tradeExit";
import { errorMessage } from "@/lib/util";

// User-initiated exit of a portfolio HOLDING. Holdings are not the same set as
// tracked trades — most have no trade record behind them — so this sells the
// holding's shares and, only if a matching open trade exists, closes that too.
// Where there is no trade, the next portfolio sync reconciles the position.

const exitSchema = z.object({ confirmLive: z.coerce.boolean().default(false) });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const numId = parseInt(id, 10);
  if (!isFinite(numId)) return NextResponse.json({ error: "bad id" }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const parsed = exitSchema.safeParse(body ?? {});
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const db = getDb();
  const holding = db
    .select()
    .from(schema.portfolioHoldings)
    .where(eq(schema.portfolioHoldings.id, numId))
    .get();
  if (!holding) return NextResponse.json({ error: "not found" }, { status: 404 });

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
    const plan = planHoldingExit(holding, { marketOpen: clock.isOpen });
    if (!plan.ok) return NextResponse.json({ error: plan.reason }, { status: 400 });

    // If a tracked trade covers this ticker, close it at the same fill so the
    // trade book and the holdings list do not disagree.
    const trade = db
      .select()
      .from(schema.activeTrades)
      .where(and(eq(schema.activeTrades.ticker, holding.ticker), eq(schema.activeTrades.status, "open")))
      .get();

    const result = await exitTradeAtBroker(
      svc,
      {
        id: holding.id,
        ticker: holding.ticker,
        direction: "long",
        shares: holding.shares,
        stopLoss: trade?.stopLoss ?? null,
      },
      {
        closeTradeFn: ({ exitPrice, exitReason }) =>
          trade ? closeTrade(trade, { exitPrice, exitReason }) : undefined,
        onAlert: (severity, message) => emitAlert("trade_exit", severity, message, holding.ticker),
      },
    );

    if (!result.ok) return NextResponse.json({ error: result.reason, ...result }, { status: 502 });
    return NextResponse.json({
      ok: true,
      exitPrice: result.exitPrice,
      legsCancelled: result.legsCancelled,
      closedTrade: trade != null,
    });
  } catch (err) {
    return NextResponse.json({ error: errorMessage(err) }, { status: 502 });
  }
}
