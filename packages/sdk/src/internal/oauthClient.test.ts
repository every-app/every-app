import { describe, expect, it } from "vitest";
import { CAPABILITIES, type OAuthClientCapability } from "./capabilities";
import { oauthClientCredentials } from "./oauthClient";

/** A provider's capability with its own setting names. */
const PLAIN: OAuthClientCapability = {
  ...CAPABILITIES["google-workspace"],
  label: "Plain",
  secrets: { clientId: "PLAIN_CLIENT_ID", clientSecret: "PLAIN_CLIENT_SECRET" },
};

describe("oauthClientCredentials", () => {
  it("needs the id and the secret", () => {
    expect(oauthClientCredentials(PLAIN, {})).toBeNull();
    expect(oauthClientCredentials(PLAIN, { PLAIN_CLIENT_ID: "id" })).toBeNull();
    expect(
      oauthClientCredentials(PLAIN, {
        PLAIN_CLIENT_ID: "id",
        PLAIN_CLIENT_SECRET: "  ",
      }),
    ).toBeNull();
    expect(
      oauthClientCredentials(PLAIN, {
        PLAIN_CLIENT_ID: " id ",
        PLAIN_CLIENT_SECRET: " secret ",
      }),
    ).toEqual({ clientId: "id", clientSecret: "secret" });
  });

  it("needs the id alone for a public client", () => {
    const pub: OAuthClientCapability = {
      ...PLAIN,
      secrets: { clientId: "PLAIN_CLIENT_ID" },
    };
    expect(oauthClientCredentials(pub, { PLAIN_CLIENT_ID: "id" })).toEqual({
      clientId: "id",
    });
  });
});
