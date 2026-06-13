import { NextResponse } from "next/server";
import { syncPortfolio } from "@/services/marketData";

export async function POST() {
  const result = await syncPortfolio();
  if ("error" in result) {
    return NextResponse.json(result, { status: 502 });
  }
  return NextResponse.json(result);
}
