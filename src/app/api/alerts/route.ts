import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { getRecentAlerts } from "@/services/alerts";

export async function GET() {
  return NextResponse.json(getRecentAlerts());
}

const ackSchema = z.object({ id: z.coerce.number() });

export async function PATCH(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = ackSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }
  getDb()
    .update(schema.alerts)
    .set({ acknowledged: true })
    .where(eq(schema.alerts.id, parsed.data.id))
    .run();
  return NextResponse.json({ ok: true });
}
