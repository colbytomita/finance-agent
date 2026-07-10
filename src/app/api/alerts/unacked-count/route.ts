import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";

// Unacknowledged-alert count for the header badge (roadmap #42).

export async function GET() {
  const rows = getDb()
    .select({ severity: schema.alerts.severity })
    .from(schema.alerts)
    .where(eq(schema.alerts.acknowledged, false))
    .all();
  return NextResponse.json({
    count: rows.length,
    critical: rows.filter((r) => r.severity === "critical").length,
  });
}
