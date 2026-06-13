import { NextResponse } from "next/server";
import { listCandidates, runDiscoveryScan } from "@/services/discoveryAgent";

export const maxDuration = 300;

export async function GET() {
  return NextResponse.json({ candidates: listCandidates() });
}

export async function POST() {
  try {
    const result = await runDiscoveryScan();
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
