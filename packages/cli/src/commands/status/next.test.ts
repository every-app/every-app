/**
 * The next-step rules of `everyapp status` (next.ts), each on and off
 * against facts, with the dedupe against fixes, the four-line cap and the
 * hosted mode. The reads behind the facts are status.test.ts's.
 */
import type { SettingsManifestLike } from "@every-app/sdk/internal";
import { describe, expect, it } from "vitest";
import { appSetupFrom } from "@/lib/app/settings";
import { NEXT_STEPS_MAX, NextCode, nextStepsFor, type NextFacts, type ProviderFact } from "./next";
import { ProblemCode, Severity, type AppState, type Problem } from "./problems";

const GATEWAY = "https://example.com";

/** A live app; `manifest` gives it settings, evaluated against `gatewayNames`. */
function app(
  id: string,
  {
    manifest,
    gatewayNames = [],
    status = "active",
    bound = true,
  }: {
    manifest?: SettingsManifestLike;
    gatewayNames?: readonly string[];
    status?: string;
    bound?: boolean;
  } = {},
): AppState {
  return {
    id,
    hostname: `${id}.example.com`,
    workerName: `every-acme-${id}`,
    status,
    bound,
    deployedBy: "dev@example.com",
    email: { senders: [], inbound: [], routed: [], declaresInbound: false },
    publicRoutes: [],
    mcp: null,
    setup: manifest ? appSetupFrom({ manifest, appId: id, gatewayNames, secretNames: [] }).setup : null,
  };
}

const dataforseo = (on: boolean): ProviderFact => ({
  id: "dataforseo",
  name: "DataForSEO",
  capability: "dataforseo",
  keySetting: "DATAFORSEO_API_KEY",
  on,
});

/** A fix whose command is `run`, as problems.ts makes them. */
function fix(code: ProblemCode, run: string): Problem {
  return { code, severity: Severity.Warning, headline: code, detail: [], run: { text: run, human: run } };
}

/** Everything done: no step. Each test undoes one thing. */
function done(over: Partial<NextFacts> = {}): NextFacts {
  return {
    mode: "self_hosted",
    uploaded: true,
    gatewayUrl: GATEWAY,
    owner: { email: "owner@example.com", organizationName: "Acme" },
    apps: [app("todo")],
    gatewayNames: ["OPENAI_API_KEY", "EMAIL_FROM", "EMAIL_FROM_NAME"],
    access: { on: true, teamDomain: "acme.cloudflareaccess.com", drift: null, driftUnread: null },
    providers: [dataforseo(false)],
    counts: { members: 2, invitations: 0, connections: 1, tokens: 0, toolApps: 1 },
    problems: [],
    ...over,
  };
}

const codes = (facts: NextFacts) => nextStepsFor(facts).map((step) => step.code);

describe("nextStepsFor", () => {
  it("suggests nothing when everything is done", () => {
    expect(nextStepsFor(done())).toEqual([]);
  });

  describe("AI_KEY", () => {
    const optionalAi = { providers: [{ id: "openrouter", why: "Drafts replies.", optional: true }] };

    it("names the key the apps use when no AI key is set, for apps that run without it", () => {
      const facts = done({ gatewayNames: ["EMAIL_FROM"], apps: [app("crm", { manifest: optionalAi })] });
      expect(nextStepsFor(facts)).toEqual([
        {
          code: NextCode.AiKey,
          command: "pnpm everyapp secret set OPENROUTER_API_KEY",
          note: "AI for crm",
          why: "crm uses AI once OPENROUTER_API_KEY is set; no AI key is set on the Gateway.",
        },
      ]);
    });

    it("names every key the apps use, once each", () => {
      const facts = done({
        gatewayNames: [],
        apps: [
          app("crm", { manifest: optionalAi }),
          app("chef", { manifest: { providers: [{ id: "openai", optional: true }] } }),
          app("notes", { manifest: optionalAi }),
        ],
      });
      expect(nextStepsFor(facts)[0]).toMatchObject({
        command: "pnpm everyapp secret set OPENROUTER_API_KEY OPENAI_API_KEY",
        note: "AI for crm, chef and notes",
        why: "crm, chef and notes use AI once OPENROUTER_API_KEY and OPENAI_API_KEY are set; no AI key is set on the Gateway.",
      });
    });

    it("is off once any AI key is set, when no app uses AI, or when a fix names the key", () => {
      const crm = app("crm", { manifest: optionalAi });
      expect(codes(done({ gatewayNames: ["WORKERS_AI_API_TOKEN"], apps: [crm] }))).not.toContain(NextCode.AiKey);
      expect(codes(done({ gatewayNames: [] }))).not.toContain(NextCode.AiKey);
      // Required for another app: APP_NEEDS_SETUP already says to set it.
      // openseo requires the key: its APP_NEEDS_SETUP fix names it already.
      const openseo = app("openseo", { manifest: { providers: [{ id: "openrouter", why: "Writes audits." }] } });
      expect(codes(done({ gatewayNames: [], apps: [crm, openseo] }))).not.toContain(NextCode.AiKey);
      // The names couldn't be read: nothing to say.
      expect(codes(done({ gatewayNames: null, apps: [crm] }))).not.toContain(NextCode.AiKey);
    });
  });

  describe("PROVIDER_OFFER and PROVIDER_KEY", () => {
    it("offers a provider app whose key is set while it is off", () => {
      const facts = done({ gatewayNames: ["OPENAI_API_KEY", "EMAIL_FROM", "DATAFORSEO_API_KEY"] });
      expect(nextStepsFor(facts)).toEqual([
        {
          code: NextCode.ProviderOffer,
          command: "pnpm everyapp mcp on dataforseo",
          note: "offer DataForSEO's tools to AI clients (each call spends DataForSEO credit)",
          why: "DATAFORSEO_API_KEY is set and DataForSEO is off.",
        },
      ]);
      expect(codes({ ...facts, providers: [dataforseo(true)] })).toEqual([]);
      expect(codes({ ...facts, uploaded: false })).toEqual([]);
    });

    it("doesn't offer it while a deployed app lists the provider's capability: the key is that app's", () => {
      const openseo = app("openseo", {
        manifest: { capabilities: { dataforseo: { access: "read", why: "Keyword data." } } },
        gatewayNames: ["DATAFORSEO_API_KEY"],
      });
      const facts = done({ gatewayNames: ["OPENAI_API_KEY", "EMAIL_FROM", "DATAFORSEO_API_KEY"], apps: [openseo] });
      expect(codes(facts)).toEqual([]);
      // Without that app, the offer is back.
      expect(codes({ ...facts, apps: [app("todo")] })).toEqual([NextCode.ProviderOffer]);
    });

    it("asks for the key of a provider app that is on without it", () => {
      const facts = done({ providers: [dataforseo(true)] });
      expect(nextStepsFor(facts)).toEqual([
        {
          code: NextCode.ProviderKey,
          command: "pnpm everyapp secret set DATAFORSEO_API_KEY",
          note: "DataForSEO is on and needs its key",
          why: 'DataForSEO shows "needs setup" and serves no tools until DATAFORSEO_API_KEY is set.',
        },
      ]);
      // An app that requires the key has its fix already.
      const seo = app("seo", { manifest: { capabilities: { dataforseo: { access: "read", why: "Keyword data." } } } });
      expect(codes({ ...facts, apps: [seo] })).toEqual([]);
      expect(codes({ ...facts, gatewayNames: null })).toEqual([]);
    });
  });

  describe("ACCESS_OFF", () => {
    it("recommends Access on a self-hosted Gateway that has none", () => {
      const facts = done({ access: { on: false, teamDomain: null, drift: null, driftUnread: null } });
      expect(nextStepsFor(facts)).toEqual([
        {
          code: NextCode.AccessOff,
          command: "pnpm everyapp access on",
          note: "put Cloudflare Access in front (recommended)",
          why: "Cloudflare Access is off; the Gateway's own sign-in is the only check in front of your apps.",
        },
      ]);
      expect(codes({ ...facts, mode: "hosted" })).toEqual([]);
      expect(codes({ ...facts, uploaded: false })).toEqual([]);
      // Unclaimed: `access on` would refuse (nobody to let in); the fix says setup.
      expect(codes({ ...facts, owner: null })).toEqual([]);
      // Not read (cf couldn't say): ACCESS_UNKNOWN is the fix, nothing here.
      expect(codes({ ...facts, access: null })).toEqual([]);
    });
  });

  describe("INVITE", () => {
    it("points at Users while the owner is the only member, nobody is invited, and an app is up", () => {
      const facts = done({ counts: { members: 1, invitations: 0, connections: 1, tokens: 0, toolApps: 1 } });
      expect(nextStepsFor(facts)).toEqual([
        {
          code: NextCode.Invite,
          url: "https://example.com/admin/users",
          note: "invite people",
          why: "owner@example.com is the only member.",
        },
      ]);
      expect(codes({ ...facts, apps: [app("todo", { status: "pending", bound: false })] })).toEqual([]);
      // Invited, not joined yet: the owner has done it.
      expect(codes({ ...facts, counts: { ...facts.counts!, invitations: 1 } })).toEqual([]);
      expect(codes({ ...facts, counts: null })).toEqual([]);
      expect(codes(done())).toEqual([]);
    });
  });

  describe("CONNECT_AI", () => {
    it("points at the connector steps, naming /mcp, while no client is connected and apps serve tools", () => {
      const facts = done({ counts: { members: 2, invitations: 0, connections: 0, tokens: 0, toolApps: 2 } });
      expect(nextStepsFor(facts)).toEqual([
        {
          code: NextCode.ConnectAi,
          url: "https://everyapp.com/docs/connect-ai",
          note: "connect an AI client to https://example.com/mcp",
          why: "No AI client is connected; 2 apps serve tools.",
        },
      ]);
      expect(nextStepsFor({ ...facts, counts: { ...facts.counts!, toolApps: 1 } })[0]?.why).toBe(
        "No AI client is connected; 1 app serves tools.",
      );
      // A personal token counts as a client; so does no app with tools.
      expect(codes({ ...facts, counts: { ...facts.counts!, tokens: 1 } })).toEqual([]);
      expect(codes({ ...facts, counts: { ...facts.counts!, toolApps: 0 } })).toEqual([]);
      expect(codes({ ...facts, counts: null })).toEqual([]);
    });
  });

  describe("CREATE_APP", () => {
    it("says create on an uploaded Gateway with no apps", () => {
      expect(nextStepsFor(done({ apps: [] }))).toEqual([
        {
          code: NextCode.CreateApp,
          command: "pnpm everyapp create ../my-app",
          note: "start your first app",
          why: "No apps yet.",
        },
      ]);
      expect(codes(done({ apps: [], uploaded: false }))).toEqual([]);
    });
  });

  describe("EMAIL_UNSET", () => {
    const sends = { capabilities: { email: { access: "write", why: "Sends digests.", optional: true } } };

    it("asks for a sender while there are people to invite or an app that sends mail", () => {
      const facts = done({ gatewayNames: ["OPENAI_API_KEY"] });
      expect(nextStepsFor(facts)).toEqual([
        {
          code: NextCode.EmailUnset,
          command: "pnpm everyapp secret set EMAIL_FROM EMAIL_FROM_NAME",
          note: "email invites and password resets; needs Cloudflare Email Sending",
          why: "No sender is set: invites and resets go out by link.",
        },
      ]);
      // One member (INVITE comes first), and an app that sends mail.
      const one = { members: 1, invitations: 0, connections: 1, tokens: 0, toolApps: 1 };
      const withApp = nextStepsFor({ ...facts, counts: one, apps: [app("crm", { manifest: sends })] });
      expect(withApp.map((step) => step.code)).toEqual([NextCode.Invite, NextCode.EmailUnset]);
      expect(withApp[1]?.why).toBe(
        "No sender is set: invites and resets go out by link, and crm sends mail once there is one.",
      );
      expect(codes({ ...facts, counts: one })).toEqual([NextCode.Invite]);
      expect(codes({ ...facts, counts: null })).toEqual([]);
    });

    it("is off once EMAIL_FROM is set, when a fix names it, or when the names weren't read", () => {
      // The name may be inside EMAIL_FROM, so EMAIL_FROM_NAME alone decides nothing.
      expect(codes(done({ gatewayNames: ["EMAIL_FROM"] }))).toEqual([]);
      // An app that requires email has its fix already (its unmet setting names EMAIL_FROM).
      const required = { capabilities: { email: { access: "write", why: "Sends invoices." } } };
      expect(codes(done({ gatewayNames: [], apps: [app("billing", { manifest: required })] }))).toEqual([]);
      expect(codes(done({ gatewayNames: null }))).toEqual([]);
    });
  });

  it("keeps the design's order and stops at four", () => {
    const everything = done({
      gatewayNames: ["DATAFORSEO_API_KEY"],
      apps: [app("crm", { manifest: { providers: [{ id: "openrouter", optional: true }] } })],
      access: { on: false, teamDomain: null, drift: null, driftUnread: null },
      counts: { members: 1, invitations: 0, connections: 0, tokens: 0, toolApps: 1 },
    });
    expect(codes(everything)).toEqual([
      NextCode.AiKey,
      NextCode.ProviderOffer,
      NextCode.AccessOff,
      NextCode.Invite,
    ]);
    expect(codes(everything)).toHaveLength(NEXT_STEPS_MAX);
    // With Access on, the next in line takes the fourth place.
    expect(codes({ ...everything, access: { on: true, teamDomain: null, drift: null, driftUnread: null } })).toEqual([
      NextCode.AiKey,
      NextCode.ProviderOffer,
      NextCode.Invite,
      NextCode.ConnectAi,
    ]);
  });

  it("never repeats a fix's command", () => {
    const facts = done({ apps: [], problems: [fix(ProblemCode.GatewayNotUploaded, "pnpm everyapp create ../my-app")] });
    expect(codes(facts)).toEqual([]);
  });
});
