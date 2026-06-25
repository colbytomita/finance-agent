import { NextResponse } from "next/server";
import { deleteMention } from "@/services/entityMentions";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const numId = parseInt(id, 10);
  if (!Number.isFinite(numId)) return NextResponse.json({ error: "bad id" }, { status: 400 });

  const result = deleteMention(numId);
  if ("error" in result) return NextResponse.json(result, { status: 404 });
  return NextResponse.json(result);
}
