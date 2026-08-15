import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { AlpacaService } from "@/services/alpaca";
import { emitAlert } from "@/services/alerts";
import { closeTrade } from "@/services/trades";
import { exitTradeAtBroker } from "@/services/tradeExit";
import { exitAllPositions, type BulkExitTarget } from "@/services/exitAll";
import { runPerformanceBacktest } from "@/services/signalPerformance";
import { errorMessage } from "@/lib/util";

// Close EVERY open tracked trade in one reviewed action (roadmap #76). Requires
// a literal typed confirmation, because it sends a real order per position.
// User-initiated only — nothing schedules this.

const CONFIRM_PHRASE = "EXIT ALL";

const bodySchema = z.object({
  confirm: z.string(),
  confirmLive: z.coerce.boolean().default(false),
  /** Recorded on every journal entry created by this batch. */
  exitReason: z.string().nullish(),
  /** Whether the thesis played out — applied to all trades in the batch. */
  thesisPlayedOut: z.union([z.boolean(), z.string()]).nullish(),
  /** Re-run the Signal Performance backtest afterwards so realized stats include these. */
  rerunPerformance: z.coerce.boolean().default(true),
});

const asBool = (v: boolean | string | null | undefined): boolean | null => {
  if (v == null) return null;
  if (typeof v === "boolean") return v;
  const s = v.trim().toLowerCase();
  if (s === "") return null;
  if (["yes", "y", "true", "1"].includes(s)) return true;
  if (["no", "n", "false", "0"].includes(s)) return false;
  return null;
};

export async function POST(req: Request) {
  const parsed = bodySchema.safeParse((await req.json().catch(() => ({}))) ?? {});
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const d = parsed.data;

  if (d.confirm !== CONFIRM_PHRASE) {
    return NextResponse.json({ error: `Type "${CONFIRM_PHRASE}" to confirm.` }, { status: 400 });
  }

  const svc = AlpacaService.fromEnv();
  if (!svc) return NextResponse.json({ error: "Alpaca is not configured." }, { status: 400 });
  if (svc.mode === "live" && !d.confirmLive) {
    return NextResponse.json(
      { error: "This is a LIVE account — resubmit with confirmLive to sell real shares." },
      { status: 400 },
    );
  }

  const db = getDb();
  const trades = db
    .select()
    .from(schema.activeTrades)
    .where(eq(schema.activeTrades.status, "open"))
    .all()
    .filter((t) => t.broker);
  if (trades.length === 0) return NextResponse.json({ ok: true, results: [], succeeded: 0, failed: 0 });

  try {
    const clock = await svc.getMarketClock();
    const thesis = asBool(d.thesisPlayedOut);

    const result = await exitAllPositions(svc, trades as BulkExitTarget[], {
      marketOpen: clock.isOpen,
      onAlert: (severity, message) => emitAlert("trade_exit", severity, message, null),
      exitOne: (service, trade) => {
        const row = trades.find((t) => t.id === trade.id)!;
        return exitTradeAtBroker(service, trade, {
          closeTradeFn: ({ exitPrice }) =>
            closeTrade(row, {
              exitPrice,
              exitReason: d.exitReason ?? "Bulk exit — closing the book",
              thesisPlayedOut: thesis,
            }),
          onAlert: (severity, message) => emitAlert("trade_exit", severity, message, trade.ticker),
        });
      },
    });

    if (result.refused) return NextResponse.json({ error: result.refusedReason }, { status: 400 });

    // Realized stats should reflect the exits immediately (the cached report is
    // what /performance renders).
    let performanceRerun = false;
    if (d.rerunPerformance && result.succeeded > 0) {
      try {
        await runPerformanceBacktest();
        performanceRerun = true;
      } catch {
        /* a stale report must not fail the exit that already happened */
      }
    }

    return NextResponse.json({ ok: true, ...result, performanceRerun });
  } catch (err) {
    return NextResponse.json({ error: errorMessage(err) }, { status: 502 });
  }
}
