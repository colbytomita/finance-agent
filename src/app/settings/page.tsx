"use client";

import { useEffect, useState } from "react";

interface SettingsResponse {
  config: Record<string, unknown>;
  integrations: {
    alpacaConfigured: boolean;
    alpacaMode: string;
    llmConfigured: boolean;
    llmProvider: string;
  };
}

const FIELDS: { key: string; label: string; type: "number" | "select" | "checkbox" | "text"; options?: string[]; hint?: string; placeholder?: string }[] = [
  { key: "riskProfile", label: "Risk profile", type: "select", options: ["conservative", "balanced", "aggressive"], hint: "Adjusts risk-per-trade, R/R minimum, earnings avoidance, and concentration caps." },
  { key: "accountValue", label: "Account value (fallback)", type: "number", hint: "Used for position sizing when Alpaca is not connected." },
  { key: "riskPerTradePercent", label: "Risk per trade (%)", type: "number" },
  { key: "minRiskReward", label: "Minimum risk/reward", type: "number" },
  { key: "maxPortfolioConcentrationPercent", label: "Max position weight (%)", type: "number" },
  { key: "maxSectorConcentrationPercent", label: "Max sector weight (%)", type: "number" },
  { key: "stopLossWarningPercent", label: "Stop-loss warning distance (%)", type: "number" },
  { key: "drawdownWarningPercent", label: "Drawdown warning (%)", type: "number" },
  { key: "avoidEarningsWithinDays", label: "Avoid earnings within (days)", type: "number", hint: "0 disables earnings avoidance." },
  { key: "staleDataMinutes", label: "Data stale after (minutes)", type: "number" },
  { key: "refreshIntervalMarketOpenSec", label: "Refresh interval, market open (sec)", type: "number" },
  { key: "refreshIntervalExtendedHoursSec", label: "Refresh interval, pre/after hours (sec)", type: "number" },
  { key: "refreshIntervalClosedSec", label: "Refresh interval, closed (sec)", type: "number" },
  { key: "yahooEnabled", label: "Yahoo Finance connector", type: "checkbox", hint: "Extended-hours quotes, news scan, earnings fetch, and keyless daily bars — via Yahoo's HTTP endpoints, headless browser only as fallback. Off = no Yahoo traffic at all." },
  { key: "agentMinScore", label: "Agent pick min score (1–10)", type: "number", hint: "Discovery agent proposes stocks scoring at or above this. Higher = stricter, fewer picks. Also the default min for Sector Scout." },
  { key: "regimeFilterEnabled", label: "Market-regime filter (Agent Picks)", type: "checkbox", hint: "When the broad market (SPY) is below its 50-day average, raise the Agent Picks bar by 1 point. A nudge in a weak tape — never a hard block; the pick rationale says when it applied." },
  { key: "portfolioWatchlistRecLimit", label: "Portfolio→watchlist suggestions shown", type: "number", hint: "How many of your holdings that aren't on the watchlist to suggest adding (Watchlist page). 0 hides them." },
  { key: "sectorScoutScanEnabled", label: "Sector Scout auto-scan (scheduled)", type: "checkbox", hint: "Re-scan each favorite industry below on the daily schedule. Manual scans on the Sector Scout page work regardless." },
  { key: "sectorScoutThesisEnabled", label: "Sector Scout thesis validation", type: "checkbox", hint: "Adds evidence-backed company-claim validation to Sector Scout picks." },
  { key: "sectorScoutThesisMaxReports", label: "Sector Scout thesis report cap", type: "number", hint: "Max companies per scan that receive deeper thesis research. Lower = faster and cheaper." },
  { key: "sectorScoutThesisMinScore", label: "Sector Scout thesis-led min score", type: "number", hint: "Names below the chart score can still surface if their evidence-backed thesis score reaches this." },
  { key: "eventIngestionEnabled", label: "Event ingestion (scheduled)", type: "checkbox", hint: "Catalyst Edge: pull real-world events on the daily schedule. Manual 'Run ingestion' works regardless." },
  { key: "eventSourceSecEnabled", label: "Source: SEC EDGAR 8-K", type: "checkbox", hint: "Official, free filing feed of material corporate events." },
  { key: "eventSourceGdeltEnabled", label: "Source: GDELT news", type: "checkbox", hint: "News coverage of public-figure statements (requires gdeltQueries in config)." },
  { key: "eventSourceIrEnabled", label: "Source: company IR RSS", type: "checkbox", hint: "Company investor-relations feeds (requires irFeeds in config)." },
  { key: "eventIngestionMaxItems", label: "Event ingestion item cap", type: "number", hint: "Max raw items processed per run. Lower = cheaper LLM extraction." },
  { key: "eventMinConfidence", label: "Event min confidence", type: "select", options: ["low", "medium", "high"], hint: "Drop extracted events below this confidence before storing." },
  { key: "notifyEnabled", label: "Alert notifications", type: "checkbox", hint: "Push alerts out of the app: a desktop notification (macOS/Windows), plus ntfy when a topic is set below." },
  { key: "notifyMinSeverity", label: "Notify at or above severity", type: "select", options: ["info", "warning", "critical"], hint: "critical = stop-loss hits, exit recommendations. warning adds stop-loss proximity." },
  { key: "ntfyTopic", label: "ntfy topic", type: "text", placeholder: "my-secret-topic", hint: "Subscribe to this topic in the ntfy app (ntfy.sh) to get alerts on your phone. Pick something unguessable; leave empty to disable." },
  { key: "morningBriefEnabled", label: "Morning brief (daily)", type: "checkbox", hint: "One compact daily summary after the 08:00 maintenance refresh: market regime, earnings inside your avoid window, trades flagged Exit/Trim, buy-zone hits, fresh quality setups. Needs 'Alert notifications' on; ignores the severity gate — this toggle is the opt-in." },
];

interface IrFeedSetting {
  ticker: string;
  url: string;
}

/** Shape of POST /api/settings/test-notification (roadmap #34). */
interface TestNotificationResult {
  desktop: { attempted: boolean; ok: boolean; detail: string };
  ntfy: { attempted: boolean; ok: boolean; detail: string };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function irFeedList(value: unknown): IrFeedSetting[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (v): v is IrFeedSetting =>
      Boolean(v) &&
      typeof v === "object" &&
      typeof (v as IrFeedSetting).ticker === "string" &&
      typeof (v as IrFeedSetting).url === "string",
  );
}

function parseLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseIrFeeds(text: string): IrFeedSetting[] {
  return parseLines(text)
    .map((line) => {
      const [ticker, ...rest] = line.split(",");
      return {
        ticker: (ticker ?? "").trim().toUpperCase(),
        url: rest.join(",").trim(),
      };
    })
    .filter((feed) => feed.ticker && feed.url);
}

export default function SettingsPage() {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [form, setForm] = useState<Record<string, unknown>>({});
  const [gdeltText, setGdeltText] = useState("");
  const [irFeedsText, setIrFeedsText] = useState("");
  const [sectorText, setSectorText] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<TestNotificationResult | null>(null);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d: SettingsResponse) => {
        setData(d);
        setForm(d.config);
        setGdeltText(stringList(d.config.gdeltQueries).join("\n"));
        setIrFeedsText(irFeedList(d.config.irFeeds).map((f) => `${f.ticker}, ${f.url}`).join("\n"));
        setSectorText(stringList(d.config.sectorScoutIndustries).join("\n"));
      })
      .catch(() => setMsg("Failed to load settings"));
  }, []);

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...form,
          gdeltQueries: parseLines(gdeltText),
          irFeeds: parseIrFeeds(irFeedsText),
          sectorScoutIndustries: parseLines(sectorText),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ? "validation failed — check source list formatting" : "validation failed");
      if (data?.config) setForm(data.config);
      setMsg("Saved");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  async function testNotifications() {
    setTestBusy(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/settings/test-notification", { method: "POST" });
      const d = (await res.json()) as TestNotificationResult;
      if (!res.ok) throw new Error("test failed");
      setTestResult(d);
    } catch {
      setTestResult({
        desktop: { attempted: false, ok: false, detail: "Request failed." },
        ntfy: { attempted: false, ok: false, detail: "Request failed." },
      });
    } finally {
      setTestBusy(false);
    }
  }

  if (!data) return <p className="text-sm text-zinc-500">Loading settings…</p>;

  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-lg font-bold">Settings</h1>

      <section className="card">
        <h2 className="card-title">Integrations (configured via .env — secrets never shown here)</h2>
        <ul className="space-y-1 text-sm">
          <li>
            Alpaca:{" "}
            {data.integrations.alpacaConfigured ? (
              <span className="pos">connected ({data.integrations.alpacaMode} mode)</span>
            ) : (
              <span className="text-amber-400">not configured — set ALPACA_API_KEY / ALPACA_API_SECRET in .env</span>
            )}
          </li>
          <li>
            LLM research agent:{" "}
            {data.integrations.llmConfigured ? (
              <span className="pos">connected ({data.integrations.llmProvider})</span>
            ) : (
              <span className="text-zinc-400">no API key — rule-based summaries are used</span>
            )}
          </li>
        </ul>
      </section>

      <section className="card space-y-3">
        <h2 className="card-title">Risk & refresh configuration</h2>
        {FIELDS.map((f) => (
          <div key={f.key} className="flex items-center justify-between gap-4">
            <div>
              <label className="block">{f.label}</label>
              {f.hint && <span className="text-[10px] text-zinc-600">{f.hint}</span>}
            </div>
            {f.type === "select" ? (
              <select
                value={String(form[f.key] ?? "")}
                onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
              >
                {f.options!.map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
            ) : f.type === "checkbox" ? (
              <input
                type="checkbox"
                checked={Boolean(form[f.key])}
                onChange={(e) => setForm({ ...form, [f.key]: e.target.checked })}
              />
            ) : f.type === "text" ? (
              <input
                type="text"
                className="w-48"
                placeholder={f.placeholder}
                value={String(form[f.key] ?? "")}
                onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
              />
            ) : (
              <input
                type="number"
                step="any"
                className="w-32"
                value={String(form[f.key] ?? "")}
                onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
              />
            )}
          </div>
        ))}
        <div className="flex items-center gap-3 pt-2">
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save settings"}
          </button>
          {msg && <span className="text-xs text-zinc-400">{msg}</span>}
        </div>
      </section>

      <section className="card space-y-2">
        <h2 className="card-title">Test notifications</h2>
        <p className="text-[10px] text-zinc-600">
          Sends one clearly-labeled test through each configured channel (ignoring the severity
          gate) so you can verify the wiring before a real alert needs it. Uses the <em>saved</em>{" "}
          settings — save first if you just changed the ntfy topic.
        </p>
        <button className="btn" onClick={testNotifications} disabled={testBusy}>
          {testBusy ? "Sending…" : "Send test notification"}
        </button>
        {testResult && (
          <ul className="space-y-1 text-xs">
            {(["desktop", "ntfy"] as const).map((ch) => {
              const r = testResult[ch];
              return (
                <li key={ch}>
                  <span className="font-semibold text-zinc-300">{ch}:</span>{" "}
                  <span className={r.ok ? "pos" : r.attempted ? "neg" : "text-zinc-500"}>
                    {r.ok ? "sent" : r.attempted ? "failed" : "skipped"}
                  </span>{" "}
                  <span className="text-zinc-500">{r.detail}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="card space-y-3">
        <h2 className="card-title">Catalyst Edge source lists</h2>
        <div className="space-y-1">
          <label className="block">GDELT queries</label>
          <textarea
            className="min-h-28 w-full font-mono text-xs"
            value={gdeltText}
            onChange={(e) => setGdeltText(e.target.value)}
            placeholder={"Powell inflation rate cuts\nFDA approval biotech\nactivist investor 13D"}
          />
          <p className="text-[10px] text-zinc-600">
            One search query per line. Used only when the GDELT source is enabled.
          </p>
        </div>

        <div className="space-y-1">
          <label className="block">Company IR RSS feeds</label>
          <textarea
            className="min-h-28 w-full font-mono text-xs"
            value={irFeedsText}
            onChange={(e) => setIrFeedsText(e.target.value)}
            placeholder={"NVDA, https://investor.nvidia.com/rss/news-releases.xml\nAAPL, https://example.com/rss"}
          />
          <p className="text-[10px] text-zinc-600">
            One feed per line as <span className="text-zinc-400">TICKER, URL</span>. Used only when
            the IR RSS source is enabled.
          </p>
        </div>

        <div className="flex items-center gap-3 pt-2">
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save source lists"}
          </button>
          {msg && <span className="text-xs text-zinc-400">{msg}</span>}
        </div>
      </section>

      <section className="card space-y-3">
        <h2 className="card-title">Sector Scout favorite industries</h2>
        <div className="space-y-1">
          <label className="block">Favorite industries / themes</label>
          <textarea
            className="min-h-28 w-full font-mono text-xs"
            value={sectorText}
            onChange={(e) => setSectorText(e.target.value)}
            placeholder={"space\nenergy\nnuclear fusion\ncybersecurity"}
          />
          <p className="text-[10px] text-zinc-600">
            One industry or theme per line. When <span className="text-zinc-400">Sector Scout auto-scan</span>{" "}
            (above) is on, daily maintenance re-scans each of these and refreshes its picks. You can always
            scan any industry on demand from the{" "}
            <a href="/sector-scout" className="text-sky-300 hover:underline">Sector Scout</a> page.
          </p>
        </div>

        <div className="flex items-center gap-3 pt-2">
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save industries"}
          </button>
          {msg && <span className="text-xs text-zinc-400">{msg}</span>}
        </div>
      </section>

      <p className="text-[11px] text-zinc-600">
        This app is decision support only. It never places trades, never guarantees returns, and all
        scores are heuristic interpretations of the data available to it.
      </p>
    </div>
  );
}
