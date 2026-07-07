import { NextResponse } from "next/server";
import { z } from "zod";
import { watchEntity, unwatchEntity } from "@/services/watchedEntities";

// Star/unstar a Catalyst-Edge entity (roadmap #24). Watched entities raise an
// alert when event ingestion finds new mentions of them.
const schema = z.object({ entity: z.string().min(1).max(120), watched: z.coerce.boolean() });

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  if (parsed.data.watched) watchEntity(parsed.data.entity);
  else unwatchEntity(parsed.data.entity);
  return NextResponse.json({ ok: true, watched: parsed.data.watched });
}
