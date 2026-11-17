/**
 * What `everyapp setup` (and `update`) ends with: the `done` event
 * for each outcome, and what a new Gateway's owner is told to do next.
 */
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { CLI } from "@/lib/output/command";
import { createNdjsonSink, type EventSink } from "@/lib/output/events";
import { reportGatewayResult } from "./index";
import type { SetupResult } from "./runSetup";

const INSTALLED: SetupResult = {
  gatewayUrl: "https://apps.example.com",
  account: "Acme",
  owner: "ben@example.com",
  organizationName: "Example Inc",
  release: "0.4.0",
  releaseName: "0.4.0",
  gateway: "installed",
  ownerCreated: true,
  mode: "self_hosted",
  accessOn: null,
  usageReports: null,
};

/** The one event a result is reported as. */
function reported(result: SetupResult) {
  const events: Array<Record<string, any>> = [];
  const out = createNdjsonSink((line) => events.push(JSON.parse(line)));
  reportGatewayResult(out, result, Date.now());
  expect(events).toHaveLength(1);
  return events[0]!;
}

/** What a person sees under the steps: the event's `display`, which --json leaves out. */
function displayed(result: SetupResult): string {
  let display = "";
  reportGatewayResult({ emit: (event) => void (display = "display" in event ? String(event.display) : "") } as EventSink, result, Date.now());
  return stripVTControlCharacters(display);
}

const commands = (next: Array<{ command: string }>) => next.map((step) => step.command);

describe("what setup ends with", () => {
  it("tells a new self-hosted Gateway's owner what to set up next: an app, Access, AI, then email", () => {
    expect(reported(INSTALLED)).toMatchObject({
      type: "done",
      data: {
        gatewayUrl: "https://apps.example.com",
        adminUrl: "https://apps.example.com/admin",
        owner: "ben@example.com",
        mode: "self_hosted",
        gateway: "installed",
        facts: [
          { label: "Gateway", value: "https://apps.example.com" },
          {
            label: "Admin",
            value: "https://apps.example.com/admin",
            note: "invite people, choose who opens which app",
          },
        ],
        next: [
          { command: `${CLI} create ../my-app`, note: "start your first app" },
          {
            command: `${CLI} access on`,
            note: "put Cloudflare Access in front of your Gateway (recommended)",
          },
          {
            command: `${CLI} secret set OPENAI_API_KEY`,
            note: "AI for apps (or OPENROUTER_API_KEY, WORKERS_AI_API_TOKEN)",
          },
          {
            command: `${CLI} secret set EMAIL_FROM EMAIL_FROM_NAME`,
            note: "email invites and password resets; needs Cloudflare Email Sending",
          },
        ],
      },
    });
  });

  it("says Access is on, and leaves access on out of the next steps, once setup turned it on", () => {
    const { data } = reported({ ...INSTALLED, accessOn: true });
    expect(data["accessOn"]).toBe(true);
    expect(data["facts"]).toContainEqual({ label: "Access", value: "on", note: "everyone signs in through Cloudflare Access first" });
    expect(commands(data["next"])).toEqual([
      `${CLI} create ../my-app`,
      `${CLI} secret set OPENAI_API_KEY`,
      `${CLI} secret set EMAIL_FROM EMAIL_FROM_NAME`,
    ]);
    // Declined: the next steps still recommend it, and no fact claims it.
    const declined = reported({ ...INSTALLED, accessOn: false })["data"];
    expect(commands(declined["next"])).toContain(`${CLI} access on`);
    expect(declined["facts"]).not.toContainEqual(expect.objectContaining({ label: "Access" }));
  });

  it("says the same once a Gateway that was there gets its owner", () => {
    const { data } = reported({ ...INSTALLED, gateway: "upgraded" });
    expect(commands(data["next"])).toEqual([
      `${CLI} create ../my-app`,
      `${CLI} access on`,
      `${CLI} secret set OPENAI_API_KEY`,
      `${CLI} secret set EMAIL_FROM EMAIL_FROM_NAME`,
    ]);
  });

  it("leaves Cloudflare Access out for a hosted Gateway, which ignores it", () => {
    const { data } = reported({ ...INSTALLED, mode: "hosted" });
    expect(data["mode"]).toBe("hosted");
    expect(data["next"]).toEqual([
      { command: `${CLI} create ../my-app`, note: "start your first app" },
      { command: `${CLI} secret set OPENAI_API_KEY`, note: "turn on AI for apps" },
      {
        command: `${CLI} secret set EMAIL_FROM EMAIL_FROM_NAME`,
        note: "email invites; needs Cloudflare Email Sending",
      },
    ]);
  });

  it("says only where the Gateway is when nobody claimed it (CI)", () => {
    const { data } = reported({
      ...INSTALLED,
      owner: null,
      organizationName: null,
      ownerCreated: false,
    });
    expect(data["facts"]).toEqual([{ label: "Gateway", value: "https://apps.example.com" }]);
    expect(data).not.toHaveProperty("next");
  });

  it("names the release an upgrade went to, with nothing new to set up", () => {
    const event = reported({ ...INSTALLED, gateway: "upgraded", ownerCreated: false });
    expect(event["message"]).toBe("Upgraded to 0.4.0");
    expect(event["data"]).not.toHaveProperty("next");
  });

  it("points an up-to-date Gateway at status", () => {
    const { data } = reported({ ...INSTALLED, gateway: "up-to-date", ownerCreated: false });
    expect(data["next"]).toEqual([
      { command: `${CLI} status`, note: "see apps, domains and certificates" },
    ]);
  });
});

describe("what setup and update say about usage reports", () => {
  const NOTICE = {
    usageReports: "on",
    startsAt: "2026-11-23T12:00:00.000Z",
    notice: {
      headline: "Usage reports start on 23 November for this Gateway.",
      detail:
        "Once a day it will send Every App a few rounded counts: members, apps, MCP servers, how many people used them, AI tool calls, the version. Never your domain, names, emails or anything inside an app.",
    },
  } as const;
  const UPGRADED: SetupResult = { ...INSTALLED, gateway: "upgraded", ownerCreated: false, release: "0.4.2", releaseName: "0.4.2" };

  it("an update of a Gateway that existed before them prints the notice, with the two commands", () => {
    const done = reported({ ...UPGRADED, usageReports: NOTICE });
    expect(displayed({ ...UPGRADED, usageReports: NOTICE }).replace(/ in \d+.*$/m, " in 41s")).toBe(
      [
        "Gateway  https://apps.example.com",
        "Upgraded to 0.4.2 in 41s",
        "",
        "Usage reports start on 23 November for this Gateway.",
        "Once a day it will send Every App a few rounded counts: members, apps, MCP servers, how many people used them, AI tool calls, the version. Never your domain, names, emails or anything inside an app.",
        "",
        "See the exact report, or turn it off:",
        `  ${CLI} telemetry`,
        `  ${CLI} telemetry off`,
      ].join("\n"),
    );
    // A script gets the same words, and the notice as data to pass on.
    expect(done["message"]).toBe(
      [
        "Upgraded to 0.4.2",
        NOTICE.notice.headline,
        NOTICE.notice.detail,
        `See the exact report: ${CLI} telemetry`,
        `Turn it off: ${CLI} telemetry off`,
      ].join("\n"),
    );
    expect(done["data"]["usageReports"]).toEqual(NOTICE);
  });

  it("an update with nothing to say about them says nothing", () => {
    const done = reported(UPGRADED);
    expect(done["message"]).toBe("Upgraded to 0.4.2");
    expect(displayed(UPGRADED)).not.toContain("Usage reports");
    expect(done["data"]).not.toHaveProperty("usageReports");
  });

  it("a new Gateway's result has the line and the command", () => {
    const done = reported({ ...INSTALLED, usageReports: { ...NOTICE, notice: { ...NOTICE.notice, headline: "Usage reports start on 17 November for this Gateway." } } });
    expect(done["data"]["facts"].at(-1)).toEqual({
      label: "Usage reports",
      value: "on",
      note: "start on 17 November: a few rounded counts a day, never names or content",
    });
    expect(done["data"]["next"].at(-1)).toEqual({
      command: `${CLI} telemetry`,
      note: `see the daily usage report, or turn it off (${CLI} telemetry off)`,
    });
  });

  it("says when the run left them off, and why", () => {
    const flag = reported({ ...INSTALLED, usageReports: { usageReports: "off", because: "no-telemetry" } });
    expect(flag["data"]["facts"].at(-1)).toEqual({ label: "Usage reports", value: "off", note: "setup ran with --no-telemetry" });
    expect(commands(flag["data"]["next"])).not.toContain(`${CLI} telemetry`);
    const shell = reported({ ...UPGRADED, usageReports: { usageReports: "off", because: "do-not-track" } });
    expect(displayed({ ...UPGRADED, usageReports: { usageReports: "off", because: "do-not-track" } })).toContain("\n\nUsage reports are off for this Gateway: DO_NOT_TRACK is set in this shell.");
    expect(shell["data"]["usageReports"]).toEqual({ usageReports: "off", because: "do-not-track" });
  });
});
