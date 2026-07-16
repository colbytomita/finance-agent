import { NextResponse } from "next/server";
import { z } from "zod";
import { unarchiveSetup } from "@/services/setupArchive";

// Remove an archived-setup snapshot; the pair can list again immediately if
// the scanner still detects it (spec 2026-07-16).

const bodySchema = z.object({ id: z.number().int().positive() });

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  if (!unarchiveSetup(parsed.data.id)) {
    return NextResponse.json({ error: "archived setup not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
