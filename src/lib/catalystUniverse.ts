import universe from "@/data/catalystUniverse.json";

// Typed access to the curated "Market Catalyst Research Universe" — a static
// reference dataset (people/orgs, recurring events, and high-signal sources to
// watch for market-moving catalysts) parsed from the user's HTML report by
// scripts/parseUniverse.ts. Like the company→ticker map it is reference data,
// NOT seeded trading data, and never touches the user's database.

export interface UniverseLink {
  label: string;
  url: string;
}

export interface UniverseRow {
  rank: number;
  name: string;
  category: string;
  marketArea: string;
  tickers: string;
  why: string;
  impactExample: string;
  impactDirection: "positive" | "negative" | "mixed" | null;
  links: UniverseLink[];
  scores: string;
  frequency: string;
  bestMonitor: string;
  queries: string;
  limitations: string;
}

export interface MonitoringQueryGroup {
  category: string;
  queries: string[];
}

export interface CatalystUniverse {
  title: string;
  note: string;
  summary: { people: number; events: number; sources: number; total: number };
  people: UniverseRow[];
  events: UniverseRow[];
  sources: UniverseRow[];
  priorityAlertNote: string;
  monitoringQueries: MonitoringQueryGroup[];
  playbookNote: string;
  guidance: string[];
}

export type UniverseSection = "people" | "events" | "sources";

export function getCatalystUniverse(): CatalystUniverse {
  return universe as CatalystUniverse;
}

// GDELT's Doc API is a keyword index — it does NOT understand Google-style
// operators like `site:` or `from:`, so those queries return nothing and only
// burn the rate limit. We drop them from the set used to drive ingestion (the
// page still displays the full curated list).
function isGdeltCompatible(q: string): boolean {
  return !/\b(site:|from:)/i.test(q);
}

/** Monitoring queries flattened, de-duplicated, and filtered to GDELT-usable ones. */
export function universeMonitoringQueries(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const group of getCatalystUniverse().monitoringQueries) {
    for (const q of group.queries) {
      const key = q.trim();
      if (key && isGdeltCompatible(key) && !seen.has(key)) {
        seen.add(key);
        out.push(key);
      }
    }
  }
  return out;
}
