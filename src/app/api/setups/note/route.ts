import { NextResponse } from "next/server";
import { z } from "zod";
import { updateArchiveNote } from "@/services/setupArchive";

// Edit the free-text note on an archived setup (spec 2026-07-16).

const bodySchema = z.object({ id: z.number().int().positive(), note: z.string().max(500) });

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  if (!updateArchiveNote(parsed.data.id, parsed.data.note)) {
    return NextResponse.json({ error: "archived setup not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
