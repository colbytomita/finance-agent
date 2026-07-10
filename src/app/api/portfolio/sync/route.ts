import { NextResponse } from "next/server";
import { syncPortfolio } from "@/services/marketData";
import { backfillHoldingSectors } from "@/services/sectors";
import { loadConfig } from "@/lib/config";

export async function POST() {
  const result = await syncPortfolio();
  if ("error" in result) {
    return NextResponse.json(result, { status: 502 });
  }
  // Newly-synced holdings arrive without a sector; fill them right away
  // (roadmap #37) instead of waiting for daily maintenance. Incremental and
  // best-effort — a Yahoo hiccup must not fail the sync.
  if (loadConfig().yahooEnabled) {
    await backfillHoldingSectors().catch(() => null);
  }
  return NextResponse.json(result);
}
