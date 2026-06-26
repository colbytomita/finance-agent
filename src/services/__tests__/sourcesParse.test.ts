import { describe, expect, it } from "vitest";
import { parseRssItems, parseAtomEntries, parseFeed, decodeEntities, stripTags } from "../sources/parse";
import { parseEdgarCompany, parseEdgarCik, edgarItemsFromAtom } from "../sources/secEdgar";
import { parseGdelt } from "../sources/gdelt";
import { irItemsFromFeed } from "../sources/irRss";
import { normalizeCik, parseCikTickers } from "../sources/cikMap";

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Latest Filings</title>
  <entry>
    <title>8-K - Apple Inc. (0000320193) (Filer)</title>
    <link rel="alternate" type="text/html" href="https://www.sec.gov/x/apple.htm"/>
    <summary type="html">Form 8-K filed</summary>
    <updated>2026-06-10T12:00:00-04:00</updated>
  </entry>
  <entry>
    <title>8-K - NVIDIA Corp (0001045810) (Filer)</title>
    <link rel="alternate" type="text/html" href="https://www.sec.gov/x/nvda.htm"/>
    <updated>2026-06-09T09:00:00-04:00</updated>
  </entry>
</feed>`;

const RSS = `<rss version="2.0"><channel>
  <title>Acme IR</title>
  <item>
    <title>Acme launches &amp; ships new widget</title>
    <link>https://acme.example/pr/1</link>
    <description><![CDATA[<p>Big news for shareholders</p>]]></description>
    <pubDate>Tue, 10 Jun 2026 13:00:00 GMT</pubDate>
  </item>
</channel></rss>`;

describe("feed parsing", () => {
  it("parses Atom entries with href links and ISO dates", () => {
    const entries = parseAtomEntries(ATOM);
    expect(entries).toHaveLength(2);
    expect(entries[0].title).toBe("8-K - Apple Inc. (0000320193) (Filer)");
    expect(entries[0].link).toBe("https://www.sec.gov/x/apple.htm");
    expect(entries[0].date).toBe("2026-06-10");
  });

  it("parses RSS items, decoding entities and stripping CDATA HTML", () => {
    const items = parseRssItems(RSS);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Acme launches & ships new widget");
    expect(items[0].link).toBe("https://acme.example/pr/1");
    expect(items[0].summary).toBe("Big news for shareholders");
    expect(items[0].date).toBe("2026-06-10");
  });

  it("parseFeed auto-detects Atom vs RSS", () => {
    expect(parseFeed(ATOM)).toHaveLength(2);
    expect(parseFeed(RSS)).toHaveLength(1);
  });

  it("decodeEntities and stripTags behave", () => {
    expect(decodeEntities("AT&amp;T &#39;wins&#39;")).toBe("AT&T 'wins'");
    expect(stripTags("<b>hello</b> <i>world</i>")).toBe("hello world");
  });
});

describe("secEdgar", () => {
  it("extracts the company name even when the form type contains hyphens", () => {
    expect(parseEdgarCompany("8-K - Apple Inc. (0000320193) (Filer)")).toBe("Apple Inc.");
    expect(parseEdgarCompany("10-K - NVIDIA Corp (0001045810) (Filer)")).toBe("NVIDIA Corp");
  });

  it("maps the Atom feed to items and resolves a tickerHint for known filers", () => {
    const items = edgarItemsFromAtom(ATOM);
    expect(items).toHaveLength(2);
    expect(items[0].source).toBe("sec-edgar");
    expect(items[0].tickerHint).toBe("AAPL");
    expect(items[1].tickerHint).toBe("NVDA");
    expect(items[0].url).toBe("https://www.sec.gov/x/apple.htm");
  });

  it("parses the filer CIK (zero-padded) from the title and attaches it to items", () => {
    expect(parseEdgarCik("8-K - Apple Inc. (0000320193) (Filer)")).toBe("0000320193");
    expect(parseEdgarCik("8-K - VERISIGN INC/CA (0001014473) (Filer)")).toBe("0001014473");
    expect(parseEdgarCik("no cik here")).toBeNull();
    expect(edgarItemsFromAtom(ATOM)[0].cik).toBe("0000320193");
  });
});

describe("cikMap", () => {
  it("normalizes CIKs to 10 digits", () => {
    expect(normalizeCik(320193)).toBe("0000320193");
    expect(normalizeCik("1014473")).toBe("0001014473");
    expect(normalizeCik("0000320193")).toBe("0000320193");
  });

  it("parses SEC company_tickers.json into a CIK->ticker map", () => {
    const json = {
      "0": { cik_str: 320193, ticker: "aapl", title: "Apple Inc." },
      "1": { cik_str: 1014473, ticker: "VRSN", title: "VERISIGN INC/CA" },
      "2": { cik_str: 0, ticker: "", title: "junk" }, // dropped (no ticker)
    };
    const map = parseCikTickers(json);
    expect(map.get("0000320193")).toBe("AAPL"); // upper-cased
    expect(map.get("0001014473")).toBe("VRSN"); // outside the curated universe
    expect(map.size).toBe(2);
  });

  it("tolerates malformed input", () => {
    expect(parseCikTickers(null).size).toBe(0);
    expect(parseCikTickers("nope").size).toBe(0);
  });
});

describe("gdelt", () => {
  it("maps ArtList JSON to items with ISO dates", () => {
    const json = {
      articles: [
        { url: "https://news.example/a", title: "Official praises Tesla", seendate: "20260601T120000Z", domain: "news.example" },
        { url: "", title: "missing url is dropped", seendate: "20260601T120000Z" },
      ],
    };
    const items = parseGdelt(json, "Tesla");
    expect(items).toHaveLength(1);
    expect(items[0].source).toBe("gdelt:Tesla");
    expect(items[0].title).toBe("Official praises Tesla");
    expect(items[0].publishedAt).toBe("2026-06-01");
  });

  it("handles malformed payloads without throwing", () => {
    expect(parseGdelt(null)).toEqual([]);
    expect(parseGdelt({})).toEqual([]);
  });
});

describe("irRss", () => {
  it("maps a company feed to items carrying a tickerHint", () => {
    const items = irItemsFromFeed(RSS, { ticker: "aapl", url: "https://acme.example/rss" });
    expect(items).toHaveLength(1);
    expect(items[0].source).toBe("ir-rss:AAPL");
    expect(items[0].tickerHint).toBe("AAPL");
  });
});
