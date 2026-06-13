import { NextResponse } from "next/server";
import { z } from "zod";
import { acceptRecommendation, dismissRecommendation } from "@/services/portfolioRecommendations";

const actionSchema = z.object({
  ticker: z.string().min(1).max(10),
  companyName: z.string().nullish(),
  action: z.enum(["accept", "dismiss"]),
});

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = actionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "ticker and action ('accept' | 'dismiss') are required" },
      { status: 400 },
    );
  }
  const { ticker, companyName, action } = parsed.data;
  const result =
    action === "accept" ? acceptRecommendation(ticker, companyName) : dismissRecommendation(ticker);
  return NextResponse.json(result);
}
