import { describe, expect, it } from "vitest";
import { parseCfStderr } from "./errors";

// Captured from cf 1.0.0-beta.14 with NO_COLOR=1, logged out and offline.
const D1_ID_REJECTED = `
┌ Error
│ Expected a D1 database ID, but received <database>="DB". Database names and
│ binding names are not accepted.
└
`;

const NOT_LOGGED_IN = `
┌ Error
│ No authentication token found.
│
│ Please set one of the following:
│   1. Set the CLOUDFLARE_API_TOKEN environment variable
│   2. Run 'cf auth login' to authenticate via OAuth
│
│ For API tokens, visit: https://dash.cloudflare.com/profile/api-tokens
└
`;

// Captured from cf 1.0.0-beta.14 against the API (account id shortened).
const WORKFLOW_NOT_FOUND = `
┌ APIError
│ [10200] workflows.api.error.workflow.not_found
│ 404 Not Found · HTTP /accounts/0123/workflows/every-acme-todo--rank-check
└
`;

// Message text from cf's source; the API renders codes as "[code: N]".
const box = (message: string) => `┌ Error\n│ ${message}\n└\n`;

describe("parseCfStderr", () => {
  it("unwraps the boxed message and rejoins wrapped lines", () => {
    expect(parseCfStderr(D1_ID_REJECTED)).toEqual({
      message:
        'Expected a D1 database ID, but received <database>="DB". Database names and binding names are not accepted.',
      apiCodes: [],
      kind: "d1_id_rejected",
    });
  });

  it("keeps list items and paragraphs on their own lines", () => {
    const parsed = parseCfStderr(NOT_LOGGED_IN);
    expect(parsed.kind).toBe("auth");
    expect(parsed.message).toBe(
      [
        "No authentication token found.",
        "",
        "Please set one of the following:",
        "  1. Set the CLOUDFLARE_API_TOKEN environment variable",
        "  2. Run 'cf auth login' to authenticate via OAuth",
        "",
        "For API tokens, visit: https://dash.cloudflare.com/profile/api-tokens",
      ].join("\n"),
    );
  });

  it.each([
    [
      "strict_conflict",
      "Aborting the upload operation because of conflicts. To override and upload anyway, remove the `--strict` flag",
    ],
    [
      "subdomain_missing",
      "Workflows require your account to have a workers.dev subdomain. Register a workers.dev subdomain here: https://dash.cloudflare.com/acct/workers/onboarding",
    ],
    [
      "email_unverified",
      "A request to the Cloudflare API failed. Please verify your email address [code: 10034]",
    ],
    [
      "r2_not_enabled",
      "Please enable R2 through the Cloudflare Dashboard. [code: 10042]",
    ],
    ["auth", "Authentication error [code: 10000]"],
    ["not_found", 'Database "every-todo" not found'],
    [
      "not_found",
      "This Worker does not exist on your account. [code: 10007]",
    ],
    ["not_found", "get: 'key not found' [code: 10009]"],
    [
      "already_exists",
      "A database with that name already exists [code: 7502]",
    ],
    [
      "already_exists",
      "a namespace with this account ID and title already exists [code: 10014]",
    ],
    ["unknown", "Something else went wrong"],
  ] as const)("classifies %s", (kind, message) => {
    expect(parseCfStderr(box(message)).kind).toBe(kind);
  });

  it("reads an API error's box and code", () => {
    expect(parseCfStderr(WORKFLOW_NOT_FOUND)).toEqual({
      message:
        "[10200] workflows.api.error.workflow.not_found 404 Not Found · HTTP /accounts/0123/workflows/every-acme-todo--rank-check",
      apiCodes: [10200],
      kind: "not_found",
    });
  });

  it("collects every API error code", () => {
    expect(
      parseCfStderr(box("Upload failed [code: 10021] then [code: 10042]"))
        .apiCodes,
    ).toEqual([10021, 10042]);
  });

  it("falls back to the last lines when cf printed no box", () => {
    expect(
      parseCfStderr("warming up\nerror during build:\nError: boom\n").message,
    ).toBe("warming up\nerror during build:\nError: boom");
    expect(parseCfStderr("").message).toBe(
      "cf failed without an error message",
    );
  });
});
