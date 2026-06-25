import { NextResponse } from "next/server";
import { z } from "zod";
import { applyEntityEdge } from "@/services/catalystEdge";

// Applying the edge runs an event study per entity (which may backfill bars) and
// recomputes affected scores, so allow a generous duration.
export const maxDuration = 300;

const schema = z
  .object({
    entity: z.string().min(1).optional(),
    minSamples: z.coerce.number().int().min(1).max(50).optional(),
  })
  .optional();

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body ?? undefined);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  try {
    const result = await applyEntityEdge(parsed.data ?? {});
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
