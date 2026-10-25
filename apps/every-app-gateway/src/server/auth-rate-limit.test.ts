import { describe, expect, it } from "vitest";
import {
  clientAddressKey,
  rateLimitCredentialRequest,
} from "./auth-rate-limit";

/** A Workers Rate Limiting stand-in: `limit` allowed calls per key. */
function limiter(limit: number) {
  const counts = new Map<string, number>();
  return {
    keys: [] as string[],
    async limit({ key }: { key: string }) {
      this.keys.push(key);
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return { success: count <= limit };
    },
  };
}

function post(
  path: string,
  body: unknown,
  { ip = "203.0.113.7", form = false } = {},
): Request {
  return new Request(`https://gateway.example.com${path}`, {
    method: "POST",
    headers: {
      "content-type": form
        ? "application/x-www-form-urlencoded"
        : "application/json",
      "cf-connecting-ip": ip,
    },
    body: form
      ? new URLSearchParams(body as Record<string, string>).toString()
      : JSON.stringify(body),
  });
}

describe("rateLimitCredentialRequest", () => {
  it("throttles brute-force sign-in from one IP once its limit is spent", async () => {
    const env = {
      AUTH_RATE_LIMIT_IP: limiter(3),
      AUTH_RATE_LIMIT_EMAIL: limiter(100),
    };
    for (let i = 0; i < 3; i += 1) {
      await expect(
        rateLimitCredentialRequest(
          post("/api/auth/sign-in/email", { email: `u${i}@x.com` }),
          env,
        ),
      ).resolves.toBeNull();
    }

    const response = await rateLimitCredentialRequest(
      post("/api/auth/sign-in/email", { email: "u4@x.com" }),
      env,
    );
    expect(response?.status).toBe(429);
    expect(response?.headers.get("retry-after")).toBe("60");
    await expect(response?.json()).resolves.toMatchObject({
      error: "rate_limited",
    });

    // Another address is counted on its own.
    await expect(
      rateLimitCredentialRequest(
        post(
          "/api/auth/sign-in/email",
          { email: "u4@x.com" },
          { ip: "1.1.1.1" },
        ),
        env,
      ),
    ).resolves.toBeNull();
  });

  it("limits guesses at one account per IP, whatever case the email is in", async () => {
    const env = {
      AUTH_RATE_LIMIT_IP: limiter(100),
      AUTH_RATE_LIMIT_EMAIL: limiter(2),
    };
    const attempt = (email: string) =>
      rateLimitCredentialRequest(
        post("/api/auth/sign-in/email", { email, password: "guess" }),
        env,
      );

    await expect(attempt("Owner@Example.com")).resolves.toBeNull();
    await expect(attempt("owner@example.com ")).resolves.toBeNull();
    expect((await attempt("owner@example.com"))?.status).toBe(429);
    expect(env.AUTH_RATE_LIMIT_EMAIL.keys).toEqual([
      "email:203.0.113.7:owner@example.com",
      "email:203.0.113.7:owner@example.com",
      "email:203.0.113.7:owner@example.com",
    ]);
    // Normal use of other accounts goes on.
    await expect(attempt("member@example.com")).resolves.toBeNull();
  });

  it("counts an IPv6 client by its /64, however it writes the address", async () => {
    const env = { AUTH_RATE_LIMIT_IP: limiter(2) };
    const attempt = (ip: string) =>
      rateLimitCredentialRequest(
        post("/api/auth/sign-in/email", {}, { ip }),
        env,
      );

    // Two addresses in one /64, one of them written out in full.
    await expect(attempt("2001:db8:1:2::1")).resolves.toBeNull();
    await expect(
      attempt("2001:0db8:0001:0002:ffff:0000:0000:0005"),
    ).resolves.toBeNull();
    expect((await attempt("2001:db8:1:2:abcd::9"))?.status).toBe(429);
    // The next /64 is another client.
    await expect(attempt("2001:db8:1:3::1")).resolves.toBeNull();
    expect(env.AUTH_RATE_LIMIT_IP.keys.slice(0, 2)).toEqual([
      "ip:2001:db8:1:2::/64",
      "ip:2001:db8:1:2::/64",
    ]);
  });

  it("keys addresses canonically", () => {
    expect(clientAddressKey("203.0.113.7")).toBe("203.0.113.7");
    expect(clientAddressKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(clientAddressKey("2001:DB8::1")).toBe("2001:db8:0:0::/64");
    expect(clientAddressKey("::1")).toBe("0:0:0:0::/64");
    expect(clientAddressKey("64:ff9b::203.0.113.7")).toBe("64:ff9b:0:0::/64");
    expect(clientAddressKey("unknown")).toBe("unknown");
  });

  it("limits guesses at one account from any number of addresses", async () => {
    const env = {
      AUTH_RATE_LIMIT_IP: limiter(100),
      AUTH_RATE_LIMIT_EMAIL: limiter(100),
      AUTH_RATE_LIMIT_ACCOUNT: limiter(2),
    };
    const attempt = (email: string, ip: string) =>
      rateLimitCredentialRequest(
        post("/api/auth/sign-in/email", { email }, { ip }),
        env,
      );

    await expect(
      attempt("owner@example.com", "198.51.100.1"),
    ).resolves.toBeNull();
    await expect(
      attempt("Owner@example.com", "198.51.100.2"),
    ).resolves.toBeNull();
    expect((await attempt("owner@example.com", "2001:db8::1"))?.status).toBe(
      429,
    );
    expect(env.AUTH_RATE_LIMIT_ACCOUNT.keys.at(-1)).toBe(
      "account:owner@example.com",
    );
    // Other accounts go on.
    await expect(
      attempt("member@example.com", "198.51.100.1"),
    ).resolves.toBeNull();
  });

  it("finds the email in every body Better Auth would read one from", async () => {
    const env = { AUTH_RATE_LIMIT_ACCOUNT: limiter(100) };
    const attempt = (contentType: string, body: BodyInit) =>
      rateLimitCredentialRequest(
        new Request("https://gateway.example.com/api/auth/sign-in/email", {
          method: "POST",
          headers: {
            "content-type": contentType,
            "cf-connecting-ip": "203.0.113.7",
          },
          body,
        }),
        env,
      );
    const json = JSON.stringify({ email: "Owner@Example.com" });
    // better-call parses all of these as JSON.
    await attempt("application/json; charset=utf-8", json);
    await attempt("application/x-www-form-urlencoded+json", json);
    await attempt("application/vnd.api+json", json);
    await attempt("application/x+json,application/json", json);
    // ...and these as form fields.
    await attempt(
      "application/x-www-form-urlencoded",
      "email=owner%40example.com",
    );
    // A repeated field: better-call keeps the last one.
    await attempt(
      "application/x-www-form-urlencoded",
      "email=someone-else%40example.com&email=owner%40example.com",
    );
    const multipart = new FormData();
    multipart.set("email", "owner@example.com");
    const encoded = new Request("https://x.example", {
      method: "POST",
      body: multipart,
    });
    await attempt(
      encoded.headers.get("content-type")!,
      await encoded.arrayBuffer(),
    );

    expect(env.AUTH_RATE_LIMIT_ACCOUNT.keys).toEqual(
      Array(7).fill("account:owner@example.com"),
    );
  });

  it("covers sign-up, password reset, the setup claim and the invite link lookup", async () => {
    for (const path of [
      "/api/auth/sign-up/email",
      "/api/auth/request-password-reset",
      "/api/setup/claim",
      "/api/invitations/lookup",
    ]) {
      const env = { AUTH_RATE_LIMIT_IP: limiter(0) };
      expect(
        (await rateLimitCredentialRequest(post(path, {}), env))?.status,
      ).toBe(429);
    }
  });

  it("counts the invite link lookup per address only, and leaves its body readable", async () => {
    const env = {
      AUTH_RATE_LIMIT_IP: limiter(1),
      AUTH_RATE_LIMIT_EMAIL: limiter(0),
      AUTH_RATE_LIMIT_ACCOUNT: limiter(0),
    };
    const request = post("/api/invitations/lookup", { token: "einv_abc" });
    await expect(rateLimitCredentialRequest(request, env)).resolves.toBeNull();
    expect(env.AUTH_RATE_LIMIT_IP.keys).toEqual(["ip:203.0.113.7"]);
    expect(env.AUTH_RATE_LIMIT_EMAIL.keys).toEqual([]);
    expect(env.AUTH_RATE_LIMIT_ACCOUNT.keys).toEqual([]);
    await expect(request.json()).resolves.toEqual({ token: "einv_abc" });
  });

  it("reads the email from form bodies too", async () => {
    const env = { AUTH_RATE_LIMIT_EMAIL: limiter(0) };
    const response = await rateLimitCredentialRequest(
      post("/api/auth/sign-in/email", { email: "a@b.co" }, { form: true }),
      env,
    );
    expect(response?.status).toBe(429);
    expect(env.AUTH_RATE_LIMIT_EMAIL.keys).toEqual([
      "email:203.0.113.7:a@b.co",
    ]);
  });

  it("counts OAuth registration and token calls unless OAuth is off", async () => {
    const off = { AUTH_RATE_LIMIT_IP: limiter(0), MCP_OAUTH_ENABLED: "false" };
    await expect(
      rateLimitCredentialRequest(post("/oauth/token", {}), off),
    ).resolves.toBeNull();
    expect(off.AUTH_RATE_LIMIT_IP.keys).toEqual([]);

    // On by default, and when turned on explicitly.
    for (const on of [
      { AUTH_RATE_LIMIT_IP: limiter(0) },
      { AUTH_RATE_LIMIT_IP: limiter(0), MCP_OAUTH_ENABLED: "true" },
    ]) {
      for (const path of ["/oauth/register", "/oauth/token"]) {
        expect(
          (await rateLimitCredentialRequest(post(path, {}), on))?.status,
        ).toBe(429);
      }
    }
  });

  it("counts single sign-on starts", async () => {
    const env = { AUTH_RATE_LIMIT_IP: limiter(0) };
    expect(
      (
        await rateLimitCredentialRequest(
          post("/api/auth/sign-in/social", {}),
          env,
        )
      )?.status,
    ).toBe(429);
  });

  it("never reads an OAuth request's body, which its route caps", async () => {
    const env = {
      AUTH_RATE_LIMIT_IP: limiter(10),
      AUTH_RATE_LIMIT_EMAIL: limiter(0),
      AUTH_RATE_LIMIT_ACCOUNT: limiter(0),
    };
    const request = post("/oauth/register", { email: "a@b.co" });
    await expect(rateLimitCredentialRequest(request, env)).resolves.toBeNull();
    expect(env.AUTH_RATE_LIMIT_EMAIL.keys).toEqual([]);
    expect(env.AUTH_RATE_LIMIT_ACCOUNT.keys).toEqual([]);
    expect(request.bodyUsed).toBe(false);
  });

  it("leaves other requests alone, and leaves the body readable", async () => {
    const env = {
      AUTH_RATE_LIMIT_IP: limiter(0),
      AUTH_RATE_LIMIT_EMAIL: limiter(0),
    };
    await expect(
      rateLimitCredentialRequest(
        new Request("https://gateway.example.com/api/auth/sign-in/email"),
        env,
      ),
    ).resolves.toBeNull();
    await expect(
      rateLimitCredentialRequest(post("/api/auth/sign-out", {}), env),
    ).resolves.toBeNull();
    expect(env.AUTH_RATE_LIMIT_IP.keys).toEqual([]);

    const allowed = {
      AUTH_RATE_LIMIT_IP: limiter(1),
      AUTH_RATE_LIMIT_EMAIL: limiter(1),
    };
    const request = post("/api/auth/sign-in/email", { email: "a@b.co" });
    await expect(
      rateLimitCredentialRequest(request, allowed),
    ).resolves.toBeNull();
    await expect(request.json()).resolves.toEqual({ email: "a@b.co" });
  });
});
