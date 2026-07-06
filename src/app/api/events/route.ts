import { NextResponse } from "next/server";
import { z } from "zod";
import { addMention, findSameDayMention, listMentions } from "@/services/entityMentions";

// Real-world event mentions: "who (entity) said what about which ticker, when".
// These feed the event-study ("catalyst edge") engine.

const mentionSchema = z.object({
  entity: z.string().min(1).max(120),
  ticker: z.string().min(1).max(10),
  claim: z.string().max(500).nullish(),
  direction: z.enum(["bullish", "bearish", "neutral", "unknown"]).nullish(),
  eventDate: z
    .string()
    .refine((s) => !Number.isNaN(new Date(s).getTime()), "eventDate must be a valid date"),
  sourceName: z.string().max(120).nullish(),
  sourceUrl: z
    .string()
    .url()
    .nullish()
    .or(z.literal("").transform(() => null)),
});

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const entity = searchParams.get("entity") ?? undefined;
  const ticker = searchParams.get("ticker") ?? undefined;
  return NextResponse.json({ mentions: listMentions({ entity, ticker }) });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = mentionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;
  const eventDate = new Date(d.eventDate).toISOString().slice(0, 10);
  // Manual duplicate guard: the study treats entity/ticker/day as one event,
  // so re-adding it would only skew the pooling. Report instead of inserting.
  const existing = findSameDayMention(d.entity, d.ticker, eventDate);
  if (existing) {
    return NextResponse.json({ ok: true, id: existing.id, duplicate: true });
  }
  const id = addMention({
    entity: d.entity,
    ticker: d.ticker,
    claim: d.claim ?? null,
    direction: d.direction ?? "unknown",
    eventDate,
    sourceName: d.sourceName ?? null,
    sourceUrl: d.sourceUrl ?? null,
  });
  return NextResponse.json({ ok: true, id, duplicate: false });
}
