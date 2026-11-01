/**
 * The upstream request each provider gets, byte for byte, pinned as
 * literals captured before the provider registry replaced the hard-coded
 * tables (docs/design/2026-10-provider-registry.md, PR 2): DataForSEO and
 * Context.dev through the capability proxy, OpenAI, OpenRouter and Workers
 * AI through the AI proxy, Google, Microsoft and Slack through the OAuth
 * client path. A change to any URL, method, header, body, redirect mode or
 * answer here is a behaviour change for a deployed app, so the expected
 * values are written out, never derived from the code. To see what the
 * code produces now: PRINT_PROVIDER_BYTES=1 on the command line.
 */
import { describe, expect, it, vi } from "vitest";
import {
  CAPABILITIES,
  type OAuthClientCapability,
} from "@every-app/sdk/internal";
import { handleAuthenticatedAiProxyRequest } from "./ai-proxy";
import { handleOAuthClientCall } from "./capabilities/oauthClient";
import { handleIntegrationProxyRequest } from "./integration-proxy";

const ORIGIN = "http://every-app-gateway.internal";

interface Seen {
  url: string;
  method: string;
  redirect: string;
  headers: [string, string][];
  body: string;
  answer: { status: number; headers: [string, string][]; body: string };
}

/** The upstream request as bytes on the wire, and the answer the app got. */
async function seen(upstream: Request, answered: Response): Promise<Seen> {
  return {
    url: upstream.url,
    method: upstream.method,
    redirect: upstream.redirect,
    headers: [...upstream.headers.entries()].sort(),
    body: await upstream.text(),
    answer: {
      status: answered.status,
      headers: [...answered.headers.entries()]
        .filter(([name]) => name !== "content-length")
        .sort(),
      body: await answered.text(),
    },
  };
}

const admit = async () => ({
  caller: {
    organizationId: "org-1",
    appId: "app",
    worker: "every-acme-app",
    orgSource: "props",
  },
  user: null,
});

/** The app's request headers: what the provider must never see, and one it must. */
const APP_HEADERS = {
  authorization: "Bearer app-supplied",
  "x-api-key": "app-supplied",
  cookie: "session=1",
  "x-everyapp-identity": "not-a-token",
  "x-user-email": "someone@example.com",
  "content-type": "application/json",
  "x-request-id": "req-1",
};

async function apiKeyCall(
  id: string,
  host: string,
  path: string,
  env: Record<string, string>,
  body: string,
): Promise<Seen> {
  let captured: Request | undefined;
  const response = await handleIntegrationProxyRequest({
    request: new Request(`${ORIGIN}/api/integrations/${id}/${host}${path}`, {
      method: "POST",
      headers: APP_HEADERS,
      body,
    }),
    capabilities: { [id]: { access: "read" } },
    env,
    admit,
    fetchUpstream: async (request) => {
      captured = request;
      return Response.json(
        { status_code: 20000, cost: 0.002, tasks: [] },
        { headers: { "set-cookie": "p=1", "x-provider": "1" } },
      );
    },
    listMembers: async () => {
      throw new Error("not a service");
    },
  });
  return seen(captured!, response);
}

async function aiCall(
  provider: string,
  path: string,
  env: Record<string, string>,
  body: string,
): Promise<Seen> {
  let captured: Request | undefined;
  const response = await handleAuthenticatedAiProxyRequest({
    request: new Request(`${ORIGIN}/api/ai/${provider}${path}?stream=false`, {
      method: "POST",
      headers: { ...APP_HEADERS, "openai-organization": "org-app" },
      body,
    }),
    provider,
    env,
    policy: { models: ["gpt-4o", "openai/gpt-4o", "@cf/meta/llama-3"] },
    caller: { organizationId: "org-1", appId: "app" },
    fetchUpstream: async (request) => {
      captured = request;
      return Response.json(
        {
          id: "cmpl-1",
          choices: [{ message: { content: "hi" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
        { headers: { "x-request-id": "up-1" } },
      );
    },
  });
  return seen(captured!, response);
}

async function oauthCall(
  id: string,
  host: string,
  path: string,
  entry: Record<string, unknown>,
  env: Record<string, string>,
  body: string,
  answer: Record<string, unknown>,
): Promise<Seen> {
  let captured: Request | undefined;
  const response = await handleOAuthClientCall({
    request: new Request(`${ORIGIN}/api/integrations/${id}/${host}${path}`, {
      method: "POST",
      headers: {
        ...APP_HEADERS,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    }),
    id,
    capability: CAPABILITIES[
      id as keyof typeof CAPABILITIES
    ] as OAuthClientCapability,
    entry: entry as never,
    env,
    admit,
    fetchUpstream: async (request) => {
      captured = request;
      return Response.json(answer, {
        headers: { "set-cookie": "p=1", "x-provider": "1" },
      });
    },
  });
  return seen(captured!, response);
}

const CASES: Record<string, () => Promise<Seen>> = {
  "dataforseo (login:password)": () =>
    apiKeyCall(
      "dataforseo",
      "api.dataforseo.com",
      "/v3/serp/google/organic/live/advanced?debug=1",
      { DATAFORSEO_API_KEY: " login@example.com:secret " },
      '[{"keyword":"running shoes"}]',
    ),
  "dataforseo (base64)": () =>
    apiKeyCall(
      "dataforseo",
      "sandbox.dataforseo.com",
      "/v3/dataforseo_labs/google/keyword_overview/live",
      { DATAFORSEO_API_KEY: btoa("login@example.com:secret") },
      '[{"keywords":["a"]}]',
    ),
  context: () =>
    apiKeyCall(
      "context",
      "api.context.dev",
      "/v1/scrape",
      { CONTEXT_API_KEY: " ctx_key " },
      '{"url":"https://example.com"}',
    ),
  openai: () =>
    aiCall(
      "openai",
      "/v1/chat/completions",
      { OPENAI_API_KEY: " sk-openai " },
      '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}],"store":true}',
    ),
  openrouter: () =>
    aiCall(
      "openrouter",
      "/api/v1/chat/completions",
      { OPENROUTER_API_KEY: "sk-or" },
      '{"model":"openai/gpt-4o","messages":[{"role":"user","content":"hi"}]}',
    ),
  "workers-ai": () =>
    aiCall(
      "workers-ai",
      "/v1/chat/completions",
      { WORKERS_AI_API_TOKEN: "cf-token", CLOUDFLARE_ACCOUNT_ID: "acc 1" },
      '{"model":"@cf/meta/llama-3","messages":[{"role":"user","content":"hi"}]}',
    ),
  "google-workspace": () =>
    oauthCall(
      "google-workspace",
      "oauth2.googleapis.com",
      "/token",
      { access: "write", scopes: ["gmail.read"] },
      {
        GOOGLE_WORKSPACE_CLIENT_ID: "gw-google-id",
        GOOGLE_WORKSPACE_CLIENT_SECRET: "gw-google-secret",
      },
      "grant_type=authorization_code&code=the-code&redirect_uri=https%3A%2F%2Fcrm.example.com%2Fintegrations%2Fgoogle%2Fcallback&code_verifier=v&client_id=app-id",
      {
        access_token: "google-access-token-789",
        refresh_token: "google-refresh-token-012",
        expires_in: 3599,
        scope: "https://www.googleapis.com/auth/gmail.readonly",
        token_type: "Bearer",
      },
    ),
  "microsoft-365": () =>
    oauthCall(
      "microsoft-365",
      "login.microsoftonline.com",
      "/common/oauth2/v2.0/token",
      { access: "write", scopes: ["identity", "mail.read"] },
      {
        MICROSOFT_365_CLIENT_ID: "gw-microsoft-id",
        MICROSOFT_365_CLIENT_SECRET: "gw-microsoft-secret",
      },
      "grant_type=authorization_code&code=the-code&redirect_uri=https%3A%2F%2Fcrm.example.com%2Fintegrations%2Fmicrosoft%2Fcallback&scope=openid+profile+email+User.Read+Mail.Read+offline_access",
      {
        token_type: "Bearer",
        scope:
          "https%3A%2F%2Fgraph.microsoft.com%2Fuser.read https%3A%2F%2Fgraph.microsoft.com%2Fmail.read",
        expires_in: 3599,
        access_token: "microsoft-access-token-345",
        refresh_token: "microsoft-refresh-token-678",
      },
    ),
  slack: () =>
    oauthCall(
      "slack",
      "slack.com",
      "/api/oauth.v2.access",
      { access: "write", scopes: ["channels.read", "messages.write"] },
      {
        SLACK_CLIENT_ID: "gw-slack-id",
        SLACK_CLIENT_SECRET: "gw-slack-secret",
      },
      "code=the-code&redirect_uri=https%3A%2F%2Fcrm.example.com%2Fintegrations%2Fslack%2Fcallback",
      {
        ok: true,
        access_token: "xoxb-1",
        token_type: "bot",
        scope:
          "channels:read,groups:read,chat:write,chat:write.public,chat:write.customize",
        bot_user_id: "U1",
        team: { id: "T1", name: "Acme" },
      },
    ),
};

/** Captured on main at 2f219527 (2026-10-25), before the registry. */
const EXPECTED: Record<string, Seen> = {
  "dataforseo (login:password)": {
    url: "https://api.dataforseo.com/v3/serp/google/organic/live/advanced?debug=1",
    method: "POST",
    redirect: "manual",
    headers: [
      ["authorization", "Basic bG9naW5AZXhhbXBsZS5jb206c2VjcmV0"],
      ["content-type", "application/json"],
      ["x-request-id", "req-1"],
    ],
    body: '[{"keyword":"running shoes"}]',
    answer: {
      status: 200,
      headers: [
        ["content-type", "application/json"],
        ["x-provider", "1"],
      ],
      body: '{"status_code":20000,"cost":0.002,"tasks":[]}',
    },
  },
  "dataforseo (base64)": {
    url: "https://sandbox.dataforseo.com/v3/dataforseo_labs/google/keyword_overview/live",
    method: "POST",
    redirect: "manual",
    headers: [
      ["authorization", "Basic bG9naW5AZXhhbXBsZS5jb206c2VjcmV0"],
      ["content-type", "application/json"],
      ["x-request-id", "req-1"],
    ],
    body: '[{"keywords":["a"]}]',
    answer: {
      status: 200,
      headers: [
        ["content-type", "application/json"],
        ["x-provider", "1"],
      ],
      body: '{"status_code":20000,"cost":0.002,"tasks":[]}',
    },
  },
  context: {
    url: "https://api.context.dev/v1/scrape",
    method: "POST",
    redirect: "manual",
    headers: [
      ["authorization", "Bearer ctx_key"],
      ["content-type", "application/json"],
      ["x-request-id", "req-1"],
    ],
    body: '{"url":"https://example.com"}',
    answer: {
      status: 200,
      headers: [
        ["content-type", "application/json"],
        ["x-provider", "1"],
      ],
      body: '{"status_code":20000,"cost":0.002,"tasks":[]}',
    },
  },
  openai: {
    url: "https://api.openai.com/v1/chat/completions?stream=false",
    method: "POST",
    redirect: "follow",
    headers: [
      ["authorization", "Bearer sk-openai"],
      ["content-type", "application/json"],
      ["x-request-id", "req-1"],
    ],
    body: '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}],"store":false}',
    answer: {
      status: 200,
      headers: [
        ["content-type", "application/json"],
        ["x-request-id", "up-1"],
      ],
      body: '{"id":"cmpl-1","choices":[{"message":{"content":"hi"}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
    },
  },
  openrouter: {
    url: "https://openrouter.ai/api/v1/chat/completions?stream=false",
    method: "POST",
    redirect: "follow",
    headers: [
      ["authorization", "Bearer sk-or"],
      ["content-type", "application/json"],
      ["x-request-id", "req-1"],
    ],
    body: '{"model":"openai/gpt-4o","messages":[{"role":"user","content":"hi"}]}',
    answer: {
      status: 200,
      headers: [
        ["content-type", "application/json"],
        ["x-request-id", "up-1"],
      ],
      body: '{"id":"cmpl-1","choices":[{"message":{"content":"hi"}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
    },
  },
  "workers-ai": {
    url: "https://api.cloudflare.com/client/v4/accounts/acc%201/ai/v1/chat/completions?stream=false",
    method: "POST",
    redirect: "follow",
    headers: [
      ["authorization", "Bearer cf-token"],
      ["content-type", "application/json"],
      ["x-request-id", "req-1"],
    ],
    body: '{"model":"@cf/meta/llama-3","messages":[{"role":"user","content":"hi"}]}',
    answer: {
      status: 200,
      headers: [
        ["content-type", "application/json"],
        ["x-request-id", "up-1"],
      ],
      body: '{"id":"cmpl-1","choices":[{"message":{"content":"hi"}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
    },
  },
  "google-workspace": {
    url: "https://oauth2.googleapis.com/token",
    method: "POST",
    redirect: "manual",
    headers: [
      ["content-type", "application/x-www-form-urlencoded"],
      ["x-request-id", "req-1"],
    ],
    body: "grant_type=authorization_code&code=the-code&redirect_uri=https%3A%2F%2Fcrm.example.com%2Fintegrations%2Fgoogle%2Fcallback&code_verifier=v&client_id=gw-google-id&client_secret=gw-google-secret",
    answer: {
      status: 200,
      headers: [
        ["content-type", "application/json"],
        ["x-provider", "1"],
      ],
      body: '{"access_token":"google-access-token-789","refresh_token":"google-refresh-token-012","expires_in":3599,"scope":"https://www.googleapis.com/auth/gmail.readonly","token_type":"Bearer"}',
    },
  },
  "microsoft-365": {
    url: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    method: "POST",
    redirect: "manual",
    headers: [
      ["content-type", "application/x-www-form-urlencoded"],
      ["x-request-id", "req-1"],
    ],
    body: "grant_type=authorization_code&code=the-code&redirect_uri=https%3A%2F%2Fcrm.example.com%2Fintegrations%2Fmicrosoft%2Fcallback&client_id=gw-microsoft-id&client_secret=gw-microsoft-secret&scope=User.Read+Mail.Read+offline_access",
    answer: {
      status: 200,
      headers: [
        ["content-type", "application/json"],
        ["x-provider", "1"],
      ],
      body: '{"token_type":"Bearer","scope":"https%3A%2F%2Fgraph.microsoft.com%2Fuser.read https%3A%2F%2Fgraph.microsoft.com%2Fmail.read","expires_in":3599,"access_token":"microsoft-access-token-345","refresh_token":"microsoft-refresh-token-678"}',
    },
  },
  slack: {
    url: "https://slack.com/api/oauth.v2.access",
    method: "POST",
    redirect: "manual",
    headers: [
      ["content-type", "application/x-www-form-urlencoded"],
      ["x-request-id", "req-1"],
    ],
    body: "code=the-code&redirect_uri=https%3A%2F%2Fcrm.example.com%2Fintegrations%2Fslack%2Fcallback&client_id=gw-slack-id&client_secret=gw-slack-secret",
    answer: {
      status: 200,
      headers: [
        ["content-type", "application/json"],
        ["x-provider", "1"],
      ],
      body: '{"ok":true,"access_token":"xoxb-1","token_type":"bot","scope":"channels:read,groups:read,chat:write,chat:write.public,chat:write.customize","bot_user_id":"U1","team":{"id":"T1","name":"Acme"}}',
    },
  },
};

describe("the providers broker byte for byte as before the registry", () => {
  const printing = Boolean(process.env["PRINT_PROVIDER_BYTES"]);

  it.each(Object.keys(CASES))("%s", async (name) => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    const actual = await CASES[name]!();
    vi.restoreAllMocks();
    if (printing) {
      process.stdout.write(
        `\n=== ${name}\n${JSON.stringify(actual, null, 2)}\n`,
      );
      return;
    }
    expect(actual).toEqual(EXPECTED[name]);
  });
});
