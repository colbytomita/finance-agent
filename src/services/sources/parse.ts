// Tiny dependency-free RSS/Atom parsing helpers. Pure (string in, data out) so
// they're unit-testable without network. Not a full XML parser — just enough to
// pull entries from well-formed feeds, defensively.

export interface FeedEntry {
  title: string;
  link: string;
  summary: string;
  date: string | null; // ISO date when parseable
}

export function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .trim();
}

export function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/** Inner text of the first <tag>…</tag> within `block` (CDATA-aware). */
function innerText(block: string, tag: string): string {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(block);
  return m ? decodeEntities(m[1]) : "";
}

function toIsoDate(raw: string): string | null {
  if (!raw) return null;
  const d = new Date(raw.trim());
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function blocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

/** Parse RSS 2.0 <item> elements. */
export function parseRssItems(xml: string): FeedEntry[] {
  return blocks(xml, "item").map((b) => ({
    title: stripTags(innerText(b, "title")),
    link: stripTags(innerText(b, "link")),
    summary: stripTags(innerText(b, "description")),
    date: toIsoDate(innerText(b, "pubDate") || innerText(b, "dc:date")),
  }));
}

/** Parse Atom <entry> elements (link comes from the href attribute). */
export function parseAtomEntries(xml: string): FeedEntry[] {
  return blocks(xml, "entry").map((b) => {
    const linkHref =
      /<link[^>]*href="([^"]+)"[^>]*\/?>/i.exec(b)?.[1] ?? stripTags(innerText(b, "id"));
    const summary = innerText(b, "summary") || innerText(b, "content");
    return {
      title: stripTags(innerText(b, "title")),
      link: decodeEntities(linkHref ?? ""),
      summary: stripTags(summary),
      date: toIsoDate(innerText(b, "updated") || innerText(b, "published")),
    };
  });
}

/** Parse either feed format; tries Atom (<entry>) then RSS (<item>). */
export function parseFeed(xml: string): FeedEntry[] {
  if (/<entry[\s>]/i.test(xml)) return parseAtomEntries(xml);
  return parseRssItems(xml);
}
