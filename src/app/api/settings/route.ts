import { NextResponse } from "next/server";
import { z } from "zod";
import { loadConfig, saveConfig } from "@/lib/config";
import { integrationsStatus } from "@/services/integrations";

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
    yahooEnabled: z.coerce.boolean(),
    agentMinScore: z.coerce.number().min(1).max(10),
    portfolioWatchlistRecLimit: z.coerce.number().int().min(0).max(50),
    sectorScoutScanEnabled: z.coerce.boolean(),
    sectorScoutIndustries: z.array(z.string().trim().min(1).max(80)).max(20),
    sectorScoutThesisEnabled: z.coerce.boolean(),
    sectorScoutThesisMaxReports: z.coerce.number().int().min(0).max(24),
    sectorScoutThesisMinScore: z.coerce.number().min(1).max(10),
    eventIngestionEnabled: z.coerce.boolean(),
    eventSourceSecEnabled: z.coerce.boolean(),
    eventSourceGdeltEnabled: z.coerce.boolean(),
    eventSourceIrEnabled: z.coerce.boolean(),
    eventIngestionMaxItems: z.coerce.number().int().min(1).max(200),
    eventMinConfidence: z.enum(["low", "medium", "high"]),
    notifyEnabled: z.coerce.boolean(),
    notifyMinSeverity: z.enum(["info", "warning", "critical"]),
    ntfyTopic: z
      .string()
      .trim()
      .max(120)
      .regex(/^[-_A-Za-z0-9]*$/, "letters, digits, - and _ only"),
    gdeltQueries: z.array(z.string().trim().min(1).max(300)).max(50),
    irFeeds: z
      .array(
        z.object({
          ticker: z.string().trim().min(1).max(10).transform((s) => s.toUpperCase()),
          url: z.string().url(),
        }),
      )
      .max(50),
  })
  .partial();

export async function GET() {
  // Secrets are never returned — only whether they are configured.
  const cfg = loadConfig();
  return NextResponse.json({ config: cfg, integrations: integrationsStatus() });
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
