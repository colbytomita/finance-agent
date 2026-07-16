import { NextResponse } from "next/server";
import { z } from "zod";
import { archiveSetup } from "@/services/setupArchive";

// Archive a recommended setup: snapshot it and hide its (ticker, setupType)
// pair from the live table while the episode lasts (spec 2026-07-16).

const bodySchema = z.object({
  setupId: z.number().int().positive(),
  note: z.string().max(500).optional(),
});

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const archived = archiveSetup(parsed.data.setupId, parsed.data.note);
  if (!archived) {
    return NextResponse.json(
      { error: "setup not found — it may have expired; refresh the page" },
      { status: 404 },
    );
  }
  return NextResponse.json({ archived });
}
