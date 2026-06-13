import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { addCatalyst } from "@/services/catalysts";

const catalystSchema = z.object({
  ticker: z.string().max(10).nullish(),
  industry: z.string().nullish(),
  title: z.string().min(3),
  summary: z.string().nullish(),
  sourceUrl: z.string().url().nullish().or(z.literal("").transform(() => null)),
  eventDate: z.string().nullish(),
  catalystType: z.string().nullish(),
  impactDirection: z.enum(["positive", "negative", "mixed", "unknown"]).nullish(),
  impactScore: z.coerce.number().min(-5).max(5).nullish(),
  confidence: z.enum(["low", "medium", "high"]).nullish(),
});

export async function GET() {
  const db = getDb();
  return NextResponse.json(db.select().from(schema.catalysts).all());
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = catalystSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;
  const id = addCatalyst({
    ticker: d.ticker || null,
    industry: d.industry ?? null,
    title: d.title,
    summary: d.summary ?? null,
    sourceUrl: d.sourceUrl ?? null,
    sourceName: "manual",
    catalystType: (d.catalystType as never) ?? undefined,
    eventDate: d.eventDate || null,
    impactDirection: d.impactDirection ?? undefined,
    impactScore: d.impactScore ?? undefined,
    confidence: d.confidence ?? undefined,
  });
  return NextResponse.json({ ok: true, id });
}
