import { NextResponse } from "next/server";
import { z } from "zod";
import { acceptSectorPick, dismissSectorPick } from "@/services/sectorScout";

const actionSchema = z.object({ action: z.enum(["accept", "dismiss"]) });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const numId = parseInt(id, 10);
  if (!isFinite(numId)) return NextResponse.json({ error: "bad id" }, { status: 400 });

  const body = await req.json().catch(() => null);
  const parsed = actionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "action must be 'accept' or 'dismiss'" }, { status: 400 });
  }

  const result =
    parsed.data.action === "accept" ? acceptSectorPick(numId) : dismissSectorPick(numId);
  if ("error" in result) return NextResponse.json(result, { status: 404 });
  return NextResponse.json(result);
}
