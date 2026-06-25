/*
 * One-time parser: convert the curated "Market Catalyst Research Universe" HTML
 * report (data/market_catalyst_research_universe.html) into a faithful,
 * structured JSON dataset bundled in src/data/catalystUniverse.json.
 *
 * This is reference data the user authored — like src/services/sources/tickerMap
 * and DEFAULT_UNIVERSE, it is a static lookup, NOT seeded/demo trading data, and
 * never touches the user's SQLite database. Re-run with `npx tsx scripts/parseUniverse.ts`
 * if the source HTML changes.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const SRC = resolve(process.cwd(), "data/market_catalyst_research_universe.html");
const OUT = resolve(process.cwd(), "src/data/catalystUniverse.json");

function decode(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&hellip;/g, "…")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&rsquo;|&lsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)));
}

/** Strip all tags from a fragment and collapse whitespace. */
function text(html: string): string {
  return decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

interface Link {
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
  links: Link[];
  scores: string;
  frequency: string;
  bestMonitor: string;
  queries: string;
  limitations: string;
}

const DIRECTION: Record<string, UniverseRow["impactDirection"]> = {
  pos: "positive",
  neg: "negative",
  mixed: "mixed",
};

function parseLinks(cell: string): Link[] {
  const links: Link[] = [];
  const re = /<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cell))) {
    links.push({ url: decode(m[1]), label: text(m[2]) });
  }
  return links;
}

function parseRow(tr: string): UniverseRow | null {
  const cells: string[] = [];
  const re = /<td[^>]*>([\s\S]*?)<\/td>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tr))) cells.push(m[1]);
  if (cells.length < 13) return null;

  const impactCell = cells[6];
  const dirMatch = /<span class="(pos|neg|mixed)">/.exec(impactCell);

  return {
    rank: parseInt(text(cells[0]), 10) || 0,
    name: text(cells[1]),
    category: text(cells[2]),
    marketArea: text(cells[3]),
    tickers: text(cells[4]),
    why: text(cells[5]),
    impactExample: text(impactCell),
    impactDirection: dirMatch ? DIRECTION[dirMatch[1]] : null,
    links: parseLinks(cells[7]),
    scores: text(cells[8]),
    frequency: text(cells[9]),
    bestMonitor: text(cells[10]),
    queries: text(cells[11]),
    limitations: text(cells[12]),
  };
}

function parseTable(tableHtml: string): UniverseRow[] {
  const tbody = /<tbody>([\s\S]*?)<\/tbody>/.exec(tableHtml)?.[1] ?? tableHtml;
  const rows: UniverseRow[] = [];
  const re = /<tr>([\s\S]*?)<\/tr>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tbody))) {
    const row = parseRow(m[1]);
    if (row) rows.push(row);
  }
  return rows;
}

function main() {
  const html = readFileSync(SRC, "utf8");

  const tables = [...html.matchAll(/<table[\s\S]*?<\/table>/g)].map((m) => m[0]);
  if (tables.length < 3) throw new Error(`expected 3 tables, found ${tables.length}`);
  const [people, events, sources] = tables.map(parseTable);

  // Section 4: monitoring queries grouped by h3, plus the "priority alert" note.
  const sec4 = /4\. Recommended Monitoring[\s\S]*?(?=<h2)/.exec(html)?.[0] ?? "";
  const priorityAlertNote = text(/<div class="note">([\s\S]*?)<\/div>/.exec(sec4)?.[1] ?? "");
  const monitoringQueries: { category: string; queries: string[] }[] = [];
  const groupRe = /<h3>([\s\S]*?)<\/h3>\s*<ul>([\s\S]*?)<\/ul>/g;
  let g: RegExpExecArray | null;
  while ((g = groupRe.exec(sec4))) {
    const category = text(g[1]);
    const queries = [...g[2].matchAll(/<li>([\s\S]*?)<\/li>/g)].map((q) => text(q[1]));
    monitoringQueries.push({ category, queries });
  }

  // Section 5: a leading playbook note plus guidance bullets.
  const sec5 = /5\. How A Finance Agent[\s\S]*$/.exec(html)?.[0] ?? "";
  const playbookNote = text(/<div class="note">([\s\S]*?)<\/div>/.exec(sec5)?.[1] ?? "");
  const guidance = [...sec5.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => text(m[1]));

  const data = {
    title: "Market Catalyst Research Universe",
    note:
      "Curated catalyst-research reference — who/what/where to watch for market-moving " +
      "catalysts. Decision support only; not advice, not a prediction, and not a buy/sell list.",
    summary: {
      people: people.length,
      events: events.length,
      sources: sources.length,
      total: people.length + events.length + sources.length,
    },
    people,
    events,
    sources,
    priorityAlertNote,
    monitoringQueries,
    playbookNote,
    guidance,
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(data, null, 2) + "\n", "utf8");

  console.log(
    `Wrote ${OUT}\n  people=${people.length} events=${events.length} sources=${sources.length}` +
      ` queryGroups=${monitoringQueries.length} guidance=${guidance.length}`,
  );
}

main();
