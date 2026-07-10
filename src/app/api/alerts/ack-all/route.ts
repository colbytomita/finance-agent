import { NextResponse } from "next/server";
import { z } from "zod";
import { ackAlerts } from "@/services/alerts";

// Bulk acknowledge (roadmap #35): ack every unacknowledged alert matching
// the same filters the /alerts page shows, so a noisy day clears in one
// click instead of dozens.

const ackAllSchema = z.object({
  severity: z.enum(["info", "warning", "critical"]).optional(),
  ticker: z.string().max(10).optional(),
});

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const parsed = ackAllSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  return NextResponse.json({ acked: ackAlerts(parsed.data) });
}
