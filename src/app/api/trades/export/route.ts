import { buildClosedTradesCsv } from "@/services/tradeExport";

export const dynamic = "force-dynamic";

// GET /api/trades/export — download closed trades + journal as CSV (roadmap #22).
export function GET() {
  const csv = buildClosedTradesCsv();
  const filename = `finance-agent-trades-${new Date().toISOString().slice(0, 10)}.csv`;
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
