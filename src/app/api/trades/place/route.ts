import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { AlpacaService, AlpacaError } from "@/services/alpaca";

// User-initiated order placement. The user fills in the trade dialog and submits;
// this sends ONE order to Alpaca (paper by default; live requires explicit
// confirmation) and, on success, logs it into active_trades so it shows up as an
// open swing trade. The app never places orders on its own.

const placeSchema = z.object({
  ticker: z.string().min(1).max(10),
  direction: z.enum(["long", "short"]).default("long"),
  shares: z.coerce.number().positive(),
  orderType: z.enum(["market", "limit"]).default("limit"),
  limitPrice: z.coerce.number().positive().nullish(),
  timeInForce: z.enum(["day", "gtc"]).default("gtc"),
  // A reference price for logging the entry when no fill price is available yet
  // (e.g. a market order, or a resting limit). Usually the setup mid / last price.
  referencePrice: z.coerce.number().positive(),
  attachBracket: z.coerce.boolean().default(true),
  stopLoss: z.coerce.number().positive().nullish(),
  targetPrice1: z.coerce.number().positive().nullish(),
  thesis: z.string().nullish(),
  logTrade: z.coerce.boolean().default(true),
  // Required to be true to send a LIVE (real-money) order.
  confirmLive: z.coerce.boolean().default(false),
});

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = placeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;

  const alpaca = AlpacaService.fromEnv();
  if (!alpaca) {
    return NextResponse.json(
      { error: "Alpaca is not configured. Set ALPACA_API_KEY / ALPACA_API_SECRET in .env." },
      { status: 400 },
    );
  }
  const mode = alpaca.mode;
  if (mode === "live" && !d.confirmLive) {
    return NextResponse.json(
      { error: "This is a LIVE account. Confirm the live-order checkbox to place a real order." },
      { status: 400 },
    );
  }

  if (d.orderType === "limit" && d.limitPrice == null) {
    return NextResponse.json({ error: "A limit order needs a limit price." }, { status: 400 });
  }

  const side = d.direction === "long" ? "buy" : "sell";
  // The price the protective legs are measured against.
  const refPrice = d.orderType === "limit" ? (d.limitPrice as number) : d.referencePrice;
  const stopLoss = d.attachBracket ? d.stopLoss ?? null : null;
  const takeProfit = d.attachBracket ? d.targetPrice1 ?? null : null;

  // Validate protective-leg placement relative to entry (long: stop below / target
  // above; short: the reverse) so we never submit a self-crossing bracket.
  for (const [label, level, mustBeBelow] of [
    ["Stop-loss", stopLoss, d.direction === "long"],
    ["Target", takeProfit, d.direction === "short"],
  ] as const) {
    if (level == null) continue;
    const wrong = mustBeBelow ? level >= refPrice : level <= refPrice;
    if (wrong) {
      return NextResponse.json(
        { error: `${label} (${level}) is on the wrong side of entry (${refPrice}).` },
        { status: 400 },
      );
    }
  }

  let order;
  try {
    order = await alpaca.placeOrder({
      symbol: d.ticker,
      qty: d.shares,
      side,
      type: d.orderType,
      timeInForce: d.timeInForce,
      limitPrice: d.limitPrice ?? null,
      stopLoss,
      takeProfit,
    });
  } catch (e) {
    const status = e instanceof AlpacaError && e.status ? 502 : 500;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status },
    );
  }

  let tradeId: number | null = null;
  if (d.logTrade) {
    const db = getDb();
    const now = new Date().toISOString();
    const entryPrice = order.filledAvgPrice ?? d.limitPrice ?? d.referencePrice;
    const broker = `alpaca-${mode}`;
    const thesis = [d.thesis?.trim(), `[${broker} ${d.orderType} order ${order.id} · ${order.status}]`]
      .filter(Boolean)
      .join(" ");
    const res = db
      .insert(schema.activeTrades)
      .values({
        ticker: d.ticker.toUpperCase(),
        direction: d.direction,
        entryPrice,
        entryDate: now,
        shares: d.shares,
        positionSize: d.shares * entryPrice,
        stopLoss,
        targetPrice1: takeProfit,
        currentPrice: entryPrice,
        thesis,
        broker,
        brokerOrderId: order.id,
        status: "open",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    tradeId = Number(res.lastInsertRowid);
  }

  return NextResponse.json({ ok: true, mode, order, tradeId });
}
