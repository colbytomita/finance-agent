import type { DataFreshness } from "./types";

export function fmtMoney(v: number | null | undefined, digits = 2): string {
  if (v == null || !isFinite(v)) return "—";
  return v.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v == null || !isFinite(v)) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(digits)}%`;
}

export function fmtNum(v: number | null | undefined, digits = 2): string {
  if (v == null || !isFinite(v)) return "—";
  return v.toFixed(digits);
}

export function fmtScore(v: number | null | undefined): string {
  if (v == null || !isFinite(v)) return "—";
  return `${v.toFixed(1)}/10`;
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function freshness(
  capturedAt: string | null | undefined,
  staleMinutes = 30,
): DataFreshness {
  if (!capturedAt) {
    return { capturedAt: null, ageMinutes: null, isStale: true, label: "no data" };
  }
  const age = (Date.now() - new Date(capturedAt).getTime()) / 60000;
  if (!isFinite(age) || age < 0) {
    return { capturedAt, ageMinutes: null, isStale: true, label: "unknown age" };
  }
  const isStale = age > staleMinutes;
  let label: string;
  if (age < 1) label = "just now";
  else if (age < 60) label = `${Math.round(age)}m ago`;
  else if (age < 60 * 24) label = `${(age / 60).toFixed(1)}h ago`;
  else label = `${Math.floor(age / 60 / 24)}d ago`;
  if (isStale) label = `stale (${label})`;
  return { capturedAt, ageMinutes: age, isStale, label };
}
