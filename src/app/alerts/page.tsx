import Link from "next/link";
import { listAlerts, alertTickers, type AlertFilter } from "@/services/alerts";
import { fmtDateTime } from "@/lib/format";
import { SeverityDot } from "@/components/badges";
import { AlertFilters, AckAlertButton, AckAllButton } from "@/components/Alerts";

export const dynamic = "force-dynamic";

export default async function AlertsPage({
  searchParams,
}: {
  searchParams: Promise<{ severity?: string; ticker?: string; ack?: string }>;
}) {
  const sp = await searchParams;
  const severity = ["info", "warning", "critical"].includes(sp.severity ?? "") ? sp.severity! : "";
  const ticker = (sp.ticker ?? "").toUpperCase();
  const ack = ["unacked", "acked"].includes(sp.ack ?? "") ? sp.ack! : "";

  const filter: AlertFilter = {
    severity: severity || undefined,
    ticker: ticker || undefined,
    acknowledged: ack === "unacked" ? false : ack === "acked" ? true : undefined,
  };
  const alerts = listAlerts(filter);
  const tickers = alertTickers();

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-bold">Alerts</h1>
        <span className="text-[11px] text-zinc-500">{alerts.length} shown</span>
        <AckAllButton
          severity={severity}
          ticker={ticker}
          count={alerts.filter((a) => !a.acknowledged).length}
        />
      </div>

      <p className="text-xs text-zinc-500">
        Every alert the app has raised — stop-loss proximity, exit recommendations, order-fill corrections,
        watched-entity mentions, and more. Filter to audit what it warned you about, and acknowledge to clear.
      </p>

      <AlertFilters severity={severity} ticker={ticker} ack={ack} tickers={tickers} />

      <div className="overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th />
              <th>Severity</th>
              <th>Ticker</th>
              <th>Type</th>
              <th>Message</th>
              <th>When</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {alerts.length === 0 && (
              <tr>
                <td colSpan={7} className="py-6 text-center text-zinc-500">
                  No alerts match these filters.
                </td>
              </tr>
            )}
            {alerts.map((a) => (
              <tr key={a.id} className={a.acknowledged ? "opacity-60" : ""}>
                <td>
                  <SeverityDot severity={a.severity} />
                </td>
                <td className="text-xs capitalize text-zinc-400">{a.severity}</td>
                <td>
                  {a.ticker ? (
                    <Link href={`/stock/${a.ticker}`} className="text-sky-300 hover:underline">
                      {a.ticker}
                    </Link>
                  ) : (
                    <span className="text-zinc-600">—</span>
                  )}
                </td>
                <td className="text-xs text-zinc-500">{a.alertType.replace(/_/g, " ")}</td>
                <td className="text-xs text-zinc-200">{a.message}</td>
                <td className="whitespace-nowrap text-[11px] text-zinc-500">{fmtDateTime(a.createdAt)}</td>
                <td>
                  {a.acknowledged ? (
                    <span className="text-[11px] text-zinc-600">ack&apos;d</span>
                  ) : (
                    <AckAlertButton id={a.id} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
