import { NextResponse } from "next/server";
import { analyzeEntity } from "@/services/entityMentions";
import { errorMessage } from "@/lib/util";

// Analyzing may backfill historical bars from Alpaca for old event dates, so
// allow a generous duration like the discovery-scan route.
export const maxDuration = 300;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const entity = searchParams.get("entity");
  if (!entity) {
    return NextResponse.json({ error: "entity query param is required" }, { status: 400 });
  }
  try {
    const analysis = await analyzeEntity(entity);
    return NextResponse.json(analysis);
  } catch (e) {
    return NextResponse.json(
      { error: errorMessage(e) },
      { status: 500 },
    );
  }
}
