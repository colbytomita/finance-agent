import { NextResponse } from "next/server";
import { z } from "zod";
import { runEventIngestion } from "@/services/eventIngestion";
import { errorMessage } from "@/lib/util";

// Ingestion fetches from external sources and may make one LLM call, so allow a
// generous duration like the discovery-scan route.
export const maxDuration = 300;

const ingestSchema = z
  .object({
    sources: z
      .object({
        sec: z.boolean().optional(),
        gdelt: z.boolean().optional(),
        ir: z.boolean().optional(),
      })
      .optional(),
    gdeltQueries: z.array(z.string()).optional(),
    irFeeds: z.array(z.object({ ticker: z.string(), url: z.string().url() })).optional(),
    maxItems: z.coerce.number().int().min(1).max(200).optional(),
    minConfidence: z.enum(["low", "medium", "high"]).optional(),
    alsoCreateCatalysts: z.boolean().optional(),
  })
  .optional();

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = ingestSchema.safeParse(body ?? undefined);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  try {
    const result = await runEventIngestion(parsed.data ?? {});
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: errorMessage(e) },
      { status: 500 },
    );
  }
}
