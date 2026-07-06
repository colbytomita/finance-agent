import { NextResponse } from "next/server";
import { z } from "zod";
import { bulkImportWatchlist } from "@/services/watchlistImport";
import { errorMessage } from "@/lib/util";

// Validating each ticker against real market data can take a while for a
// long paste (bounded concurrency, possible Yahoo-browser fallback).
export const maxDuration = 300;

const importSchema = z.object({ tickers: z.string().min(1).max(5000) });

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = importSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "paste a list of tickers" }, { status: 400 });
  }
  try {
    return NextResponse.json(await bulkImportWatchlist(parsed.data.tickers));
  } catch (e) {
    return NextResponse.json({ error: errorMessage(e) }, { status: 500 });
  }
}
