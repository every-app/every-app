import { afterEach, describe, expect, it, vi } from "vitest";
import { lookupInvitation } from "./invitation-link";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("lookupInvitation", () => {
  it("posts the token as JSON and returns what the link opens", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        organizationName: "Acme Corp",
        invitedEmail: "b•••@example.com",
      }),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(lookupInvitation("einv_abc")).resolves.toEqual({
      organizationName: "Acme Corp",
      invitedEmail: "b•••@example.com",
    });

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    // The secret travels in the body only, never in the URL.
    expect(url).toBe("/api/invitations/lookup");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ token: "einv_abc" });
  });

  it("answers null for a link the gateway refuses, whatever the reason", async () => {
    const refused = [
      Response.json({ error: "INVITATION_NOT_VALID" }, { status: 404 }),
      Response.json({ error: "INVALID_INPUT" }, { status: 400 }),
    ];
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(refused[0])
        .mockResolvedValueOnce(refused[1]),
    );

    await expect(lookupInvitation("einv_dead")).resolves.toBeNull();
    await expect(lookupInvitation("x".repeat(300))).resolves.toBeNull();
    // The refusal's body is drained, so the browser closes the request.
    expect(refused.map((response) => response.bodyUsed)).toEqual([true, true]);
  });

  it("throws when the gateway could not answer, so the page can fall back", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: "rate_limited" }, { status: 429 }),
      ),
    );

    await expect(lookupInvitation("einv_abc")).rejects.toThrow(/429/);
  });
});
