import { NextResponse } from "next/server";
import { z } from "zod";
import { listSectorPicks, listSectorScans, runSectorScan } from "@/services/sectorScout";

export const maxDuration = 300;

const scanSchema = z.object({
  // .trim() first so a whitespace-only industry fails min(1) here (400) rather
  // than passing validation and throwing later in runSectorScan (500).
  industry: z.string().trim().min(1).max(80),
  minScore: z.number().min(1).max(10).optional(),
});

export async function GET() {
  return NextResponse.json({ scans: listSectorScans(), picks: listSectorPicks() });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = scanSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "industry is required (1–80 chars)" }, { status: 400 });
  }
  try {
    const result = await runSectorScan(parsed.data);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
