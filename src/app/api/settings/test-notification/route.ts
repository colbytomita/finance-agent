import { NextResponse } from "next/server";
import { sendTestNotification } from "@/services/notifications";

// Fire one labeled test notification through each configured channel and
// report per-channel results (roadmap #34). Bypasses the severity gate — the
// user explicitly asked for it from Settings.

export async function POST() {
  const result = await sendTestNotification();
  return NextResponse.json(result);
}
