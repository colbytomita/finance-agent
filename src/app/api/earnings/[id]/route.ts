import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { deleteEarningsReport } from "@/services/earnings";
import { recomputeStockAnalysis } from "@/services/marketData";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const numId = parseInt(id, 10);
  if (!isFinite(numId)) return NextResponse.json({ error: "bad id" }, { status: 400 });

  // Grab the ticker first so we can recompute its score after removal.
  const row = getDb()
    .select({ ticker: schema.earningsReports.ticker })
    .from(schema.earningsReports)
    .where(eq(schema.earningsReports.id, numId))
    .get();

  const res = deleteEarningsReport(numId);
  if ("error" in res) return NextResponse.json(res, { status: 404 });
  if (row) {
    try {
      recomputeStockAnalysis(row.ticker);
    } catch {
      /* best effort */
    }
  }
  return NextResponse.json({ ok: true });
}
