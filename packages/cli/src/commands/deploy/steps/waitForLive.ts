/**
 * The live wait, the last step of a deploy: until the app's registry row in
 * D1 says `active`. The gateway makes a `binding` app active itself, on the
 * first request that reaches it over the service binding the deploy just
 * added; this step sends that request (`GET https://<hostname>/`) and reads
 * D1 after each one. The request is the trigger, D1 is the truth: no HTTP
 * status says an app is live by itself.
 *
 * Until the hostname has its certificate (a new one usually within five
 * minutes) and the gateway version with the binding serves (seconds),
 * nothing answers or the gateway answers 503; the wait goes on. Two answers
 * end it early, without the app going live in this run, and say it goes
 * live on its first visit: Cloudflare Access in front of the gateway (the
 * gateway never sees this request), and running out of time with no
 * certificate yet. Running out of time while the gateway answers is an
 * error: it can't reach the app.
 *
 * The request resolves the hostname at its zone's nameservers, which serve
 * a new record at once, so it goes out with no pause first. An app that
 * goes live while this computer's resolver still has no address for its
 * hostname gets a LOCAL_DNS_STALE warning: it is live, but this computer's
 * browser may not reach it yet.
 */
import { DELETED_APP_STATUS } from "@every-app/perimeter/registry";
import type { D1Database } from "@/lib/cf/d1";
import { probeHttps } from "@/lib/domains/https";
import { osLocalDns, warnIfLocalDnsStale, type LocalDns } from "@/lib/domains/localDns";
import { EveryAppError } from "@/lib/errors";
import { readAppById } from "@/lib/gateway/registry";
import { CLI } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { elapsed } from "@/lib/output/time";

const STEP = "app.live";
const DEFAULT_MAX_WAIT_MS = 600_000;
const DEFAULT_INTERVAL_MS = 3_000;
const PROGRESS_EVERY_MS = 15_000;

/** How the wait reaches the app, sleeps, and how long it waits (tests). */
export interface LiveWaitSeams {
  fetch?: typeof fetch;
  /**
   * This computer's resolver, asked once the app is live. None with a fake
   * fetch: the computer knows nothing of a fake network's names.
   */
  localDns?: LocalDns;
  sleep?: (ms: number) => Promise<void>;
  maxWaitMs?: number;
  intervalMs?: number;
  now?: () => number;
}

/** The command that waits, for its messages: what it leaves in place, and what to run again. */
export enum LiveWaitVerb {
  Deploy = "deploy",
}

const LEFT: Readonly<Record<LiveWaitVerb, string>> = {
  [LiveWaitVerb.Deploy]: "uploaded and bound",
};

/**
 * `live`: the registry says active. `first_visit`: it will be once a person
 * opens it (Access in front, or no certificate yet). `disabled`: an admin
 * switched it off.
 */
type LiveOutcome = "live" | "first_visit" | "disabled";

/** What a person waited for, when the wait showed: its certificate, or the app itself. */
type Waited = "certificate" | "live";

export async function waitForLive({
  db,
  appRowId,
  appId,
  hostname,
  out,
  verb,
  fetch: fetchImpl,
  localDns = fetchImpl ? undefined : osLocalDns,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
  now = Date.now,
}: {
  db: D1Database;
  appRowId: string;
  appId: string;
  hostname: string;
  out: EventSink;
  verb: LiveWaitVerb;
} & LiveWaitSeams): Promise<{ outcome: LiveOutcome; waited?: Waited }> {
  const url = `https://${hostname}/`;
  const started = now();
  let answered = false;
  let lastProgress: number | null = null;
  let waitedFor: Waited | undefined;
  const live = async () => {
    // Only a request this run made says the hostname resolves at its zone.
    if (answered && localDns) {
      await warnIfLocalDnsStale({
        host: hostname,
        lead: `${appId} is live at https://${hostname}`,
        out,
        step: STEP,
        localDns,
      });
    }
    return { outcome: "live" as const, waited: waitedFor };
  };

  for (;;) {
    const status = await appStatus(db, appRowId, appId);
    if (status === "active") return live();
    if (status === "disabled") {
      out.emit({
        type: "warning",
        code: "APP_DISABLED",
        step: STEP,
        message: `${appId} is switched off in Admin → Apps\nIt's ${LEFT[verb]}; the Gateway serves it once an admin turns it on.`,
      });
      return { outcome: "disabled" };
    }

    const answer = await probeHttps(url, fetchImpl);
    if (answer.answered) {
      answered = true;
      if (answer.access) {
        out.emit({
          type: "warning",
          code: "ACCESS_IN_FRONT",
          step: STEP,
          message: `Cloudflare Access answers before the Gateway, so this run can't confirm ${appId} is live\nIt goes live on its first visit, once someone signs in through Access.`,
          data: { hostname },
        });
        return { outcome: "first_visit" };
      }
      // The request reached the gateway, which activates a bound app on it.
      if ((await appStatus(db, appRowId, appId)) === "active") return live();
    }

    const waited = now() - started;
    if (waited >= maxWaitMs) {
      if (!answered) {
        out.emit({
          type: "warning",
          code: "CERT_PENDING",
          step: STEP,
          message: `No certificate for ${hostname} after ${elapsed(waited)}\nIt usually comes within 5 minutes; ${appId} goes live on its first visit once it has one.`,
          data: {
            hostname,
            fix: "if it never comes, check the zone's CAA records allow Cloudflare's certificate authorities",
          },
        });
        return { outcome: "first_visit" };
      }
      throw new EveryAppError(
        "APP_NOT_LIVE",
        `${appId} isn't live after ${elapsed(waited)}: the Gateway can't reach its Worker yet\n${appId} stays ${LEFT[verb]}.`,
        { retryable: true, rerun: `${CLI} status`, rerunNote: `then ${verb} again` },
      );
    }
    if (lastProgress === null || now() - lastProgress >= PROGRESS_EVERY_MS) {
      waitedFor = answered ? "live" : "certificate";
      out.emit({
        type: "progress",
        step: STEP,
        message: answered
          ? `Waiting for ${appId} to go live`
          : `Waiting for the certificate for ${hostname} (usually under 5m)`,
        data: { hostname, waitedMs: waited, answered },
      });
      lastProgress = now();
    }
    await sleep(intervalMs);
  }
}

async function appStatus(
  db: D1Database,
  appRowId: string,
  appId: string,
): Promise<string> {
  const app = await readAppById(db, appRowId);
  if (!app || app.status === DELETED_APP_STATUS) {
    throw new EveryAppError(
      "APP_NOT_FOUND",
      `${appId} was deleted during this run\nSomeone removed it from the Gateway while this run waited for it to go live.`,
      { retryable: true, rerunNote: "to put it back" },
    );
  }
  return app.status;
}
