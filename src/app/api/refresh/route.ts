import { NextResponse } from "next/server";
import { fullRefresh } from "@/services/marketData";
import { generateAlerts } from "@/services/alerts";
import { syncBrokerOrders } from "@/services/orderSync";
import { rollCatalystStatuses } from "@/services/catalysts";
import { errorMessage } from "@/lib/util";

export const maxDuration = 300;

export async function POST() {
  try {
    rollCatalystStatuses();
    // Reconcile broker orders first so the refresh scores corrected trades.
    const orderSync = await syncBrokerOrders().catch(() => null);
    const result = await fullRefresh();
    const newAlerts = generateAlerts();
    return NextResponse.json({ ...result, orderSync, newAlerts });
  } catch (e) {
    return NextResponse.json(
      { error: errorMessage(e) },
      { status: 500 },
    );
  }
}
