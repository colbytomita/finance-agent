import { NextResponse } from "next/server";
import { z } from "zod";
import { loadConfig, saveConfig } from "@/lib/config";

const settingsSchema = z
  .object({
    riskProfile: z.enum(["conservative", "balanced", "aggressive"]),
    riskPerTradePercent: z.coerce.number().min(0.1).max(10),
    minRiskReward: z.coerce.number().min(0.5).max(10),
    maxPortfolioConcentrationPercent: z.coerce.number().min(1).max(100),
    maxSectorConcentrationPercent: z.coerce.number().min(1).max(100),
    accountValue: z.coerce.number().min(0),
    stopLossWarningPercent: z.coerce.number().min(0.1).max(20),
    drawdownWarningPercent: z.coerce.number().min(1).max(90),
    avoidEarningsWithinDays: z.coerce.number().min(0).max(30),
    staleDataMinutes: z.coerce.number().min(1).max(1440),
    refreshIntervalMarketOpenSec: z.coerce.number().min(60).max(3600),
    refreshIntervalExtendedHoursSec: z.coerce.number().min(60).max(7200),
    refreshIntervalClosedSec: z.coerce.number().min(300).max(86400),
    yahooBrowserEnabled: z.coerce.boolean(),
    agentMinScore: z.coerce.number().min(1).max(10),
    portfolioWatchlistRecLimit: z.coerce.number().int().min(0).max(50),
    eventIngestionEnabled: z.coerce.boolean(),
    eventSourceSecEnabled: z.coerce.boolean(),
    eventSourceGdeltEnabled: z.coerce.boolean(),
    eventSourceIrEnabled: z.coerce.boolean(),
    eventIngestionMaxItems: z.coerce.number().int().min(1).max(200),
    eventMinConfidence: z.enum(["low", "medium", "high"]),
  })
  .partial();

export async function GET() {
  // Secrets are never returned — only whether they are configured.
  const cfg = loadConfig();
  return NextResponse.json({
    config: cfg,
    integrations: {
      alpacaConfigured: Boolean(process.env.ALPACA_API_KEY && process.env.ALPACA_API_SECRET),
      alpacaMode: process.env.ALPACA_MODE === "live" ? "live" : "paper",
      llmConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
      llmProvider: process.env.LLM_PROVIDER ?? "anthropic",
    },
  });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = settingsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const merged = saveConfig(parsed.data);
  return NextResponse.json({ ok: true, config: merged });
}
