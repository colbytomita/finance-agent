// Dead-runner watchdog entrypoint (roadmap #55): run by the FinanceAgentWatchdog
// scheduled task every 30 minutes. Checks the scheduler heartbeat from OUTSIDE
// the app and pushes a notification when it's stale. Exits 0 always — a
// "failing" watchdog task would just spam Task Scheduler restart logic.
import { loadDotEnv } from "@/lib/loadEnv";
loadDotEnv(); // #40 rule: tsx entrypoints don't get .env for free
import fs from "node:fs";
import path from "node:path";
import { nowIso } from "@/lib/util";

const STATE_PATH = path.resolve(process.cwd(), "data", "watchdog-state.json");

async function main(): Promise<void> {
  const dbFile = path.resolve(process.cwd(), process.env.DATABASE_PATH || "./data/finance-agent.db");
  if (!fs.existsSync(dbFile)) return; // app never set up here — nothing to watch

  // Import AFTER the existence check: getDb() would otherwise CREATE an empty
  // database (and run migrations) on a machine that never had one.
  const { getJobHealth } = await import("@/services/jobHealth");
  const { decideWatchdogAction } = await import("@/services/watchdogCheck");

  let lastNotifiedAt: string | null = null;
  try {
    lastNotifiedAt =
      (JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as { lastNotifiedAt?: string })
        .lastNotifiedAt ?? null;
  } catch {
    /* missing/corrupt state = never notified */
  }

  const heartbeatAt =
    getJobHealth().jobs.find((j) => j.job === "heartbeat")?.lastRunAt ?? null;
  // WATCHDOG_STALE_MINUTES: live-testing override (e.g. 0 forces "stale" now).
  const staleMinutes = Number.parseInt(process.env.WATCHDOG_STALE_MINUTES ?? "", 10);
  const decision = decideWatchdogAction({
    heartbeatAt,
    lastNotifiedAt,
    ...(Number.isFinite(staleMinutes) ? { staleMinutes } : {}),
  });

  if (decision.clearState) {
    try {
      fs.unlinkSync(STATE_PATH);
    } catch {
      /* already clear */
    }
    return;
  }
  if (!decision.notify || !decision.message) return;

  // Installing the watchdog task IS the opt-in for this message, so it goes
  // through the direct path (severity gate bypassed), like the channel test
  // and morning brief. Desktop toast needs no config; ntfy needs a topic.
  const { sendDirectNotification } = await import("@/services/notifications");
  await sendDirectNotification("critical", decision.message, "Runner down");
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify({ lastNotifiedAt: nowIso() }));
  console.log(`[watchdog ${nowIso()}] notified: ${decision.message}`);
}

void main().catch((e) => {
  console.error(`[watchdog] check failed:`, e);
  process.exit(0); // never a task failure
});
