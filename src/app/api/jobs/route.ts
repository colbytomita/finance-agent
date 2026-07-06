import { NextResponse } from "next/server";
import { getJobHealth } from "@/services/jobHealth";

// Scheduler health for the header badge: per-job last-run rows + staleness.
export async function GET() {
  return NextResponse.json(getJobHealth());
}
