"use client";

// Shared client-side plumbing for every button/form that hits a JSON API
// route: busy flag, success/error message state, JSON body encoding, and a
// router.refresh() so the server-rendered page picks up the change. Replaces
// the hand-rolled busy/msg/fetch/refresh block that used to be copied into
// each component.

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

export interface ApiCallOptions<T> {
  /** HTTP method — defaults to POST (these are mutations). */
  method?: string;
  /** JSON-encoded request body (content-type set automatically). */
  body?: unknown;
  /** Success message built from the response, shown until the next call. */
  message?: (data: T) => string;
  /** Stash response data (e.g. an analysis result) in component state. */
  onSuccess?: (data: T) => void;
  /** router.refresh() on success — default true; disable for pure reads. */
  refresh?: boolean;
  /** Error text when the API's { error } isn't a plain string. */
  errorText?: string;
  /**
   * Leave `busy` set after success so the control stays disabled until the
   * refresh re-renders it away (accept/dismiss rows that disappear).
   */
  keepBusyOnSuccess?: boolean;
}

export function useApiAction() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  /** Returns the parsed response on success, null on failure. */
  async function call<T = Record<string, unknown>>(
    url: string,
    opts: ApiCallOptions<T> = {},
  ): Promise<T | null> {
    setBusy(true);
    setMsg(null);
    setError(null);
    try {
      const res = await fetch(url, {
        method: opts.method ?? "POST",
        ...(opts.body !== undefined && {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(opts.body),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as T;
      if (!res.ok) {
        const err = (data as { error?: unknown }).error;
        throw new Error(typeof err === "string" ? err : (opts.errorText ?? "request failed"));
      }
      opts.onSuccess?.(data);
      if (opts.message) setMsg(opts.message(data));
      if (opts.refresh !== false) router.refresh();
      if (!opts.keepBusyOnSuccess) setBusy(false);
      return data;
    } catch (e) {
      setError(e instanceof Error ? e.message : (opts.errorText ?? "failed"));
      setBusy(false);
      return null;
    }
  }

  function reset() {
    setMsg(null);
    setError(null);
  }

  return { call, busy, msg, error, reset };
}

/** Form fields as a JSON payload; empty strings become null. */
export function formValues(e: FormEvent<HTMLFormElement>): Record<string, unknown> {
  e.preventDefault();
  const fd = new FormData(e.currentTarget);
  const out: Record<string, unknown> = {};
  for (const [k, v] of fd.entries()) {
    const s = String(v).trim();
    out[k] = s === "" ? null : s;
  }
  return out;
}
