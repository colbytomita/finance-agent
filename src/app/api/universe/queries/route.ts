import { NextResponse } from "next/server";
import { loadConfig, saveConfig } from "@/lib/config";
import { universeMonitoringQueries } from "@/lib/catalystUniverse";

// Apply the curated research universe's monitoring queries to the GDELT event
// ingestion config, so the reference data actually drives Catalyst Edge ingestion
// rather than just being browsable. Also turns on the GDELT source (and the
// master ingestion switch) so the queries take effect.

export async function GET() {
  const cfg = loadConfig();
  const queries = universeMonitoringQueries();
  const applied = queries.length > 0 && queries.every((q) => cfg.gdeltQueries.includes(q));
  return NextResponse.json({ queries, applied, gdeltEnabled: cfg.eventSourceGdeltEnabled });
}

export async function POST() {
  const queries = universeMonitoringQueries();
  const merged = saveConfig({
    gdeltQueries: queries,
    eventSourceGdeltEnabled: true,
    eventIngestionEnabled: true,
  });
  return NextResponse.json({
    ok: true,
    appliedQueries: queries.length,
    config: {
      gdeltQueries: merged.gdeltQueries,
      eventSourceGdeltEnabled: merged.eventSourceGdeltEnabled,
      eventIngestionEnabled: merged.eventIngestionEnabled,
    },
  });
}
