/**
 * What `everyapp setup` (and `update`) ends with: the `done` event
 * for each outcome, and what a new Gateway's owner is told to do next.
 */
import { describe, expect, it } from "vitest";
import { CLI } from "@/lib/output/command";
import { createNdjsonSink } from "@/lib/output/events";
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
};

/** The one event a result is reported as. */
function reported(result: SetupResult) {
  const events: Array<Record<string, any>> = [];
  const out = createNdjsonSink((line) => events.push(JSON.parse(line)));
  reportGatewayResult(out, result, Date.now());
  expect(events).toHaveLength(1);
  return events[0]!;
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
          { command: `${CLI} create my-app`, note: "start your first app" },
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
      `${CLI} create my-app`,
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
      `${CLI} create my-app`,
      `${CLI} access on`,
      `${CLI} secret set OPENAI_API_KEY`,
      `${CLI} secret set EMAIL_FROM EMAIL_FROM_NAME`,
    ]);
  });

  it("leaves Cloudflare Access out for a hosted Gateway, which ignores it", () => {
    const { data } = reported({ ...INSTALLED, mode: "hosted" });
    expect(data["mode"]).toBe("hosted");
    expect(data["next"]).toEqual([
      { command: `${CLI} create my-app`, note: "start your first app" },
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
