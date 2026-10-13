import { afterEach, describe, expect, it, vi } from "vitest";
import { claimGateway, readSetupToken } from "./setup-link";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readSetupToken", () => {
  it("reads the est_ secret from the URL fragment", () => {
    expect(readSetupToken("#token=est_abc")).toBe("est_abc");
    expect(readSetupToken("#token=est_abc&email=a%40b.c")).toBe("est_abc");
  });

  it("ignores anything that is not a setup secret", () => {
    expect(readSetupToken("")).toBeNull();
    expect(readSetupToken("#token=eak_abc")).toBeNull();
    expect(readSetupToken("#other=est_abc")).toBeNull();
  });
});

describe("claimGateway", () => {
  it("sends the password only in a JSON POST body", async () => {
    const fetch = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetch);

    await expect(
      claimGateway({
        token: "est_abc",
        name: "Ada",
        email: "a@b.c",
        password: "pw-123456",
      }),
    ).resolves.toEqual({ ok: true });

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/setup/claim");
    expect(url).not.toMatch(/token|password|est_/);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toMatchObject({
      password: "pw-123456",
    });
  });

  it("explains a bad link and retries CPU-limit failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json(
            { error: "INVALID_OR_EXPIRED_SETUP_LINK" },
            { status: 403 },
          ),
        )
        .mockResolvedValueOnce(
          new Response("Worker exceeded resource limits", { status: 503 }),
        ),
    );
    const input = { token: "est_a", name: "A", email: "a@b.c", password: "x" };

    await expect(claimGateway(input)).resolves.toMatchObject({
      ok: false,
      retry: false,
      message: expect.stringContaining("claim-link"),
    });
    await expect(claimGateway(input)).resolves.toEqual({
      ok: false,
      retry: true,
    });
  });

  it("retries while an earlier, killed claim still holds the setup lock", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: "CLAIM_IN_PROGRESS",
            message: "Another setup attempt is still running.",
          },
          { status: 503 },
        ),
      ),
    );

    await expect(
      claimGateway({
        token: "est_a",
        name: "A",
        email: "a@b.c",
        password: "x",
      }),
    ).resolves.toEqual({ ok: false, retry: true });
  });
});
