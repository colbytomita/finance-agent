import { describe, expect, it } from "vitest";
import {
  fetchGdeltNews,
  describeGdeltFailures,
  rotateQueries,
} from "../sources/gdelt";

// Scripted fetch: each call shifts the next behavior off the list (roadmap #56).
type Step =
  | { kind: "ok"; articles: { url: string; title: string }[] }
  | { kind: "status"; status: number; body?: string; headers?: Record<string, string> }
  | { kind: "nonjson"; body: string }
  | { kind: "timeout" }
  | { kind: "connectTimeout" };

const scripted = (
  steps: Step[],
): { fetchFn: typeof fetch; calls: () => number; urls: string[] } => {
  let calls = 0;
  const urls: string[] = [];
  const fetchFn = (async (url: unknown) => {
    urls.push(String(url));
    const step = steps[Math.min(calls, steps.length - 1)];
    calls++;
    if (step.kind === "timeout") {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    }
    if (step.kind === "connectTimeout") {
      // Exactly what Node/undici throws when the TCP connect exceeds its own
      // 10s ceiling: a plain TypeError whose cause carries the real code. This
      // is NOT governed by AbortSignal.timeout, so it arrives as a TypeError
      // rather than a TimeoutError — observed live against GDELT on 2026-08-06.
      throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("Connect Timeout Error"), {
          code: "UND_ERR_CONNECT_TIMEOUT",
        }),
      });
    }
    if (step.kind === "ok") {
      return new Response(JSON.stringify({ articles: step.articles }), { status: 200 });
    }
    if (step.kind === "nonjson") {
      return new Response(step.body, { status: 200 });
    }
    return new Response(step.body ?? "", { status: step.status, headers: step.headers });
  }) as unknown as typeof fetch;
  return { fetchFn, calls: () => calls, urls };
};

/** Instant sleep that records every requested pause (roadmap #57). */
const recordingSleep = (): { sleepFn: (ms: number) => Promise<void>; pauses: number[] } => {
  const pauses: number[] = [];
  return {
    sleepFn: (ms: number) => {
      pauses.push(ms);
      return Promise.resolve();
    },
    pauses,
  };
};

const art = (n: number) => ({ url: `https://x.test/${n}`, title: `Headline number ${n}` });

describe("fetchGdeltNews diagnostics (roadmap #56)", () => {
  it("returns items and zeroed failures on clean responses", async () => {
    const { fetchFn } = scripted([{ kind: "ok", articles: [art(1), art(2)] }]);
    const res = await fetchGdeltNews(["\"Apple\""], { fetchFn, spacingMs: 0 });
    expect(res.items).toHaveLength(2);
    expect(res.failures).toEqual({ throttled: 0, timedOut: 0, badPayload: 0, httpError: 0 });
  });

  it("carries on to the next query after a 429 instead of abandoning the run", async () => {
    // The old behaviour broke the whole run on the first 429, and its escape
    // hatch was a Retry-After retry — a header GDELT never sends. Result: GDELT
    // returned 0 items in all 24 recorded runs. A live run on 2026-08-06 showed
    // 429, 429, 429, then 200 with 10 articles: the run has to reach query 4.
    const { fetchFn, calls } = scripted([
      { kind: "status", status: 429, body: "slow down" },
      { kind: "status", status: 429, body: "slow down" },
      { kind: "ok", articles: [art(1), art(2)] },
    ]);
    const res = await fetchGdeltNews(["\"A\"", "\"B\"", "\"C\""], { fetchFn, spacingMs: 0 });
    expect(calls()).toBe(3);
    expect(res.failures.throttled).toBe(2);
    expect(res.items).toHaveLength(2);
  });

  it("gives up after enough CONSECUTIVE throttles to stay polite", async () => {
    // Carrying on must not become hammering. A wall of 429s means the budget is
    // genuinely gone, so stop; the day-rotation picks the tail up next run.
    const { fetchFn, calls } = scripted([{ kind: "status", status: 429, body: "slow down" }]);
    const res = await fetchGdeltNews(["\"A\"", "\"B\"", "\"C\"", "\"D\""], {
      fetchFn,
      spacingMs: 0,
      maxConsecutiveThrottled: 2,
    });
    expect(calls()).toBe(2);
    expect(res.failures.throttled).toBe(2);
  });

  it("resets the consecutive-throttle count after a success", async () => {
    // Two 429s, a success, then two more 429s is not a wall — the budget
    // recovered in between, so a limit of 2 consecutive must not end the run early.
    const { fetchFn, calls } = scripted([
      { kind: "status", status: 429 },
      { kind: "ok", articles: [art(1)] },
      { kind: "status", status: 429 },
      { kind: "ok", articles: [art(2)] },
    ]);
    const res = await fetchGdeltNews(["\"A\"", "\"B\"", "\"C\"", "\"D\""], {
      fetchFn,
      spacingMs: 0,
      maxConsecutiveThrottled: 2,
    });
    expect(calls()).toBe(4);
    expect(res.items).toHaveLength(2);
  });

  it("counts an undici connect timeout as a timeout, not an opaque http error", async () => {
    // Node's connect timeout is 10s and AbortSignal.timeout does not govern it,
    // so it surfaces as a bare TypeError. Filing that under httpError is what
    // made a month of "N http error" logs undiagnosable.
    const { fetchFn } = scripted([{ kind: "connectTimeout" }]);
    const res = await fetchGdeltNews(["\"A\""], { fetchFn, spacingMs: 0 });
    expect(res.failures.timedOut).toBe(1);
    expect(res.failures.httpError).toBe(0);
  });

  it("records what an http error actually was, so the class is not opaque", async () => {
    const { fetchFn } = scripted([{ kind: "status", status: 503 }]);
    const res = await fetchGdeltNews(["\"A\""], { fetchFn, spacingMs: 0 });
    expect(res.failures.httpError).toBe(1);
    expect(res.failures.httpErrorSample).toContain("503");
  });

  it("honors a small Retry-After by retrying the same query once", async () => {
    const { fetchFn, calls } = scripted([
      { kind: "status", status: 429, body: "wait", headers: { "retry-after": "0" } },
      { kind: "ok", articles: [art(1)] },
    ]);
    const res = await fetchGdeltNews(["\"Apple\""], { fetchFn, spacingMs: 0 });
    expect(res.items).toHaveLength(1);
    expect(res.failures.throttled).toBe(1); // the 429 still counted
    expect(calls()).toBe(2);
  });

  it("classifies timeouts (the abort fires before a slow 429 arrives)", async () => {
    const { fetchFn } = scripted([{ kind: "timeout" }]);
    const res = await fetchGdeltNews(["\"A\"", "\"B\""], { fetchFn, spacingMs: 0 });
    expect(res.items).toHaveLength(0);
    expect(res.failures.timedOut).toBe(2); // one per query — timeouts don't stop the loop
  });

  it("counts a 200 with a non-JSON body as badPayload and captures a sample", async () => {
    const { fetchFn } = scripted([{ kind: "nonjson", body: "Please limit requests to one every 5 seconds..." }]);
    const res = await fetchGdeltNews(["\"Apple\""], { fetchFn, spacingMs: 0 });
    expect(res.items).toHaveLength(0);
    expect(res.failures.badPayload).toBe(1);
    expect(res.failures.badPayloadSample).toContain("Please limit requests");
  });

  it("spaces requests 20s apart by default and caps a run at 4 queries (roadmap #57)", async () => {
    const { fetchFn, calls, urls } = scripted([{ kind: "ok", articles: [art(1)] }]);
    const { sleepFn, pauses } = recordingSleep();
    await fetchGdeltNews(["\"A\"", "\"B\"", "\"C\"", "\"D\"", "\"E\"", "\"F\""], { fetchFn, sleepFn });
    expect(calls()).toBe(4); // day-rotation (#56) cycles the tail across runs
    expect(pauses).toEqual([20000, 20000, 20000]); // between requests, none after the last
    expect(urls[0]).toContain("maxrecords=10"); // "larger queries" get shed — ask for less
  });

  it("doubles the pause after a non-429 failure — failed requests still count against the budget (roadmap #57)", async () => {
    const { fetchFn } = scripted([
      { kind: "ok", articles: [art(1)] },
      { kind: "status", status: 500 },
      { kind: "ok", articles: [art(2)] },
      { kind: "ok", articles: [art(3)] },
    ]);
    const { sleepFn, pauses } = recordingSleep();
    const res = await fetchGdeltNews(["\"A\"", "\"B\"", "\"C\"", "\"D\""], {
      fetchFn,
      sleepFn,
      spacingMs: 100,
    });
    expect(res.failures.httpError).toBe(1);
    expect(pauses).toEqual([100, 200, 100]); // doubled once after the failure, then back to normal
  });

  it("counts other HTTP errors without stopping", async () => {
    const { fetchFn } = scripted([
      { kind: "status", status: 500 },
      { kind: "ok", articles: [art(1)] },
    ]);
    const res = await fetchGdeltNews(["\"A\"", "\"B\""], { fetchFn, spacingMs: 0 });
    expect(res.failures.httpError).toBe(1);
    expect(res.items).toHaveLength(1);
  });
});

describe("describeGdeltFailures (roadmap #56)", () => {
  it("renders only the nonzero classes, human-readable", () => {
    expect(
      describeGdeltFailures({ throttled: 1, timedOut: 6, badPayload: 0, httpError: 0 }),
    ).toBe("1 throttled (429), 6 timed out");
    expect(
      describeGdeltFailures({
        throttled: 0,
        timedOut: 0,
        badPayload: 2,
        httpError: 1,
        badPayloadSample: "Please limit requests",
      }),
    ).toBe('2 bad payload (e.g. "Please limit requests"), 1 http error');
  });
});

describe("rotateQueries (roadmap #56)", () => {
  it("rotates deterministically by seed and preserves all entries", () => {
    const qs = ["a", "b", "c", "d"];
    expect(rotateQueries(qs, 0)).toEqual(["a", "b", "c", "d"]);
    expect(rotateQueries(qs, 1)).toEqual(["b", "c", "d", "a"]);
    expect(rotateQueries(qs, 5)).toEqual(["b", "c", "d", "a"]);
    expect(rotateQueries([], 3)).toEqual([]);
  });
});
