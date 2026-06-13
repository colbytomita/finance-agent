import { NextResponse } from "next/server";
import { generateBrief } from "@/services/researchAgent";

export const maxDuration = 60;

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ ticker: string }> },
) {
  const { ticker } = await params;
  if (!/^[A-Za-z.-]{1,10}$/.test(ticker)) {
    return NextResponse.json({ error: "bad ticker" }, { status: 400 });
  }
  const brief = await generateBrief(ticker.toUpperCase());
  return NextResponse.json(brief);
}
