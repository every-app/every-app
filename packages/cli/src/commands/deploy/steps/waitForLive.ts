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
 * nothing answers or the gateway answers 503; the wait goes on.
 *
 * Behind Cloudflare Access the request never reaches the gateway: Access
 * answers first, with a redirect to its login. The gateway's per-minute
 * sweep makes the app live instead (it probes every `binding` app over
 * its service binding; the launcher does the same each time it lists
 * one), so from that answer on this step sends nothing more and only
 * reads D1, which it can read through the Cloudflare API whatever stands
 * in front of the gateway. Running out of time with no certificate yet
 * ends the wait with a warning: it goes live on its first visit, once it
 * has one. Running out of time while the gateway answers is an error: it
 * can't reach the app. Running out of time behind Access is the same
 * stall, as a warning (ACCESS_IN_FRONT) naming `status` and the visit
 * that finishes it, since this run can't tell the two apart.
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
 * opens it (no certificate yet, or stalled behind Access). `disabled`: an
 * admin switched it off.
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
  /** Access answered the request: nothing of this run's reaches the gateway; the sweep makes it live. */
  let accessInFront = false;
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

    if (!accessInFront) {
      const answer = await probeHttps(url, fetchImpl);
      if (answer.answered) {
        answered = true;
        if (answer.access) {
          // Say so at once, then only read D1: the gateway's sweep does
          // what this request would have.
          accessInFront = true;
          lastProgress = null;
        } else if ((await appStatus(db, appRowId, appId)) === "active") {
          // The request reached the gateway, which activates a bound app on it.
          return live();
        }
      }
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
      if (accessInFront) {
        out.emit({
          type: "warning",
          code: "ACCESS_IN_FRONT",
          step: STEP,
          message: `Cloudflare Access answers before the Gateway, and the Gateway hasn't made ${appId} live after ${elapsed(waited)}\nThe deploy stalled: the Gateway should have reached ${appId}'s Worker within a minute of the upload. ${appId} stays ${LEFT[verb]}; opening https://${hostname} signed in through Access finishes it when the Gateway can reach it.`,
          data: { hostname, rerun: `${CLI} status`, rerunNote: `then ${verb} again` },
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
        message: accessInFront
          ? `Waiting for the Gateway to make ${appId} live`
          : answered
            ? `Waiting for ${appId} to go live`
            : `Waiting for the certificate for ${hostname} (usually under 5m)`,
        data: { hostname, waitedMs: waited, answered, ...(accessInFront ? { access: true } : {}) },
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
