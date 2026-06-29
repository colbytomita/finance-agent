import { NextResponse } from "next/server";
import { readCachedBacktest, runSignalBacktest } from "@/services/signalPerformance";

export const maxDuration = 300;

export async function GET() {
  return NextResponse.json({ summary: readCachedBacktest() });
}

export async function POST() {
  try {
    const summary = await runSignalBacktest();
    return NextResponse.json(summary);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
