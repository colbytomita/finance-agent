import { NextResponse } from "next/server";
import { fullRefresh } from "@/services/marketData";
import { generateAlerts } from "@/services/alerts";
import { rollCatalystStatuses } from "@/services/catalysts";
import { errorMessage } from "@/lib/util";

export const maxDuration = 300;

export async function POST() {
  try {
    rollCatalystStatuses();
    const result = await fullRefresh();
    const newAlerts = generateAlerts();
    return NextResponse.json({ ...result, newAlerts });
  } catch (e) {
    return NextResponse.json(
      { error: errorMessage(e) },
      { status: 500 },
    );
  }
}
