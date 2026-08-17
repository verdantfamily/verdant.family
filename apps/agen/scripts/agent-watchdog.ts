/**
 * Asks, from outside the deployment, whether autonomy is actually alive.
 *
 * The scheduler reports its own health, which is worth having and is not worth
 * trusting on its own: a process that has died reports nothing, and a report that
 * nobody reads is the same as no report. Railway's healthchecks do not close the
 * gap either — they run at deploy time only, so a scheduler that stops an hour
 * later keeps a green deployment.
 *
 * So this runs somewhere else, on a timer, and speaks only HTTP. It knows nothing
 * about the database, the volume or the code; if it can reach the site, it can
 * tell whether agents are being woken. That independence is the entire point, and
 * it is why this file imports nothing from the app.
 *
 * Exits non-zero when something is wrong, which is the alert: a scheduled GitHub
 * Actions run turns that into a notification without any additional service. Set
 * `ALERT_WEBHOOK_URL` to also post the message somewhere a human is looking.
 *
 *   node scripts/agent-watchdog.ts [base-url]
 */

const BASE = process.argv[2] ?? process.env["AGEN_URL"] ?? "https://agen.space";

/**
 * How stale a heartbeat may be before it counts as dead.
 *
 * Generously more than the 30-second tick, because a slow cycle holds the tick
 * and a watchdog that cries at the first long model call trains people to ignore
 * it. Five minutes still catches a stopped scheduler well inside one agent's
 * shortest possible interval of fifteen.
 */
const STALE_SECONDS = Number(process.env["WATCHDOG_STALE_SECONDS"] ?? 300);

/** Whether this deployment is supposed to have a scheduler at all. */
const EXPECT_SCHEDULER = process.env["WATCHDOG_EXPECT_SCHEDULER"] !== "0";

interface SchedulerHealth {
  readonly running?: boolean;
  readonly reason?: string;
  readonly lastHeartbeat?: number | null;
  readonly conflict?: string | null;
  readonly pausedReason?: string | null;
  readonly cyclesFailed?: number;
  readonly modelFailures?: number;
  readonly rpcFailures?: number;
  readonly agentsDue?: number;
  readonly nextScheduledRun?: number | null;
  readonly instanceId?: string;
}

async function health(): Promise<SchedulerHealth> {
  const response = await fetch(`${BASE}/api/v1/scheduler`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`${BASE}/api/v1/scheduler answered ${String(response.status)}`);
  }

  const body = (await response.json()) as { ok?: boolean; data?: { scheduler?: SchedulerHealth } };
  const scheduler = body.data?.scheduler;
  if (scheduler === undefined) throw new Error("the response carried no scheduler health");

  return scheduler;
}

async function main(): Promise<void> {
  const alerts: string[] = [];
  const notes: string[] = [];
  const now = Math.floor(Date.now() / 1000);

  let scheduler: SchedulerHealth;
  try {
    scheduler = await health();
  } catch (error) {
    // Unreachable is itself the alert. It could be the site, the network or the
    // process; the watchdog's job is to say that nobody can tell, not to guess.
    await alert([`agen.space scheduler health is unreachable: ${message(error)}`]);
    process.exit(1);
  }

  console.log(`instance   ${scheduler.instanceId ?? "(none)"}`);
  console.log(`running    ${String(scheduler.running ?? false)}`);
  console.log(`heartbeat  ${String(scheduler.lastHeartbeat ?? "none")}`);

  if (scheduler.running !== true) {
    if (EXPECT_SCHEDULER) {
      alerts.push(
        `the scheduler is not running on ${BASE} (${scheduler.reason ?? "no reason given"}). ` +
          "No agent is being woken. Check AGENT_SCHEDULER=1 and the boot logs.",
      );
    } else {
      notes.push("no scheduler here, which is expected for this deployment");
    }
  } else {
    const beat = scheduler.lastHeartbeat ?? 0;
    const age = now - beat;
    console.log(`age        ${String(age)}s`);

    if (beat === 0) {
      alerts.push("the scheduler is running but has never recorded a heartbeat.");
    } else if (age > STALE_SECONDS) {
      alerts.push(
        `the scheduler's last heartbeat was ${String(age)}s ago, over the ${String(STALE_SECONDS)}s limit. ` +
          "It is up but not ticking, so no agent is being woken.",
      );
    }
  }

  // A second scheduler is not a degradation, it is a correctness failure: two
  // processes waking the same agents means two of everything they decide to do.
  if (typeof scheduler.conflict === "string" && scheduler.conflict !== "") {
    alerts.push(`more than one scheduler is claiming this database. ${scheduler.conflict}`);
  }

  // Not an alert. Paused is a decision somebody made, and paging about it would
  // punish using the switch — but a pause nobody remembers turning on is exactly
  // what a report like this is for.
  if (typeof scheduler.pausedReason === "string" && scheduler.pausedReason !== "") {
    notes.push(`autonomy is paused: ${scheduler.pausedReason}`);
  }

  for (const note of notes) console.log(`note       ${note}`);

  if (alerts.length === 0) {
    console.log("\nOK. Autonomy is alive.");
    return;
  }

  await alert(alerts);
  process.exit(1);
}

async function alert(messages: readonly string[]): Promise<void> {
  const text = [`agen.space agents: ${String(messages.length)} problem(s) on ${BASE}`, ...messages.map((m) => `- ${m}`)].join(
    "\n",
  );
  console.error(`\n${text}`);

  const hook = process.env["ALERT_WEBHOOK_URL"];
  if (hook === undefined || hook === "") return;

  try {
    await fetch(hook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    // A webhook that fails must not swallow the alert it was carrying. The exit
    // code still fires, and the message is already on stderr.
    console.error(`(the alert webhook also failed: ${message(error)})`);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// A module, so top-level await is allowed. There is nothing to import here on
// purpose: the watchdog's independence from the app is what makes it worth having.
export {};

await main();
