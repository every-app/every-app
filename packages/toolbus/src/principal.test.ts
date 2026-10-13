import { describe, expect, it } from "vitest";
import { principalFromSession } from "./principal";

const session = {
  sub: "user_1",
  email: "user@example.com",
  orgId: "org_1",
  orgRole: "member",
};

function pat(scopes: string[]) {
  return {
    ...session,
    credential: { kind: "pat", actor: "pat:tok_9", scopes },
  };
}

describe("principalFromSession", () => {
  it("lets a browser session act as the user", () => {
    expect(principalFromSession(session, { sessionKind: "session" })).toEqual({
      ok: true,
      principal: {
        userId: "user_1",
        email: "user@example.com",
        organizationId: "org_1",
        orgRole: "member",
        credential: { kind: "session", id: "session" },
        access: "write",
      },
    });
  });

  it("maps personal-token scopes to MCP access", () => {
    for (const [scopes, access] of [
      [["*"], "write"],
      [["mcp:read", "mcp:write"], "write"],
      [["mcp:write"], "write"],
      [["mcp:read"], "read"],
    ] as const) {
      const resolved = principalFromSession(pat([...scopes]), {
        sessionKind: "session",
      });
      expect(resolved).toMatchObject({
        ok: true,
        principal: { access, credential: { kind: "pat", id: "tok_9" } },
      });
    }
    expect(
      principalFromSession(pat(["todos:read"]), { sessionKind: "session" }),
    ).toEqual({ ok: false, reason: "token_scope" });
  });

  it("refuses credentials it doesn't know", () => {
    expect(
      principalFromSession(
        { ...session, credential: { kind: "oauth", scopes: ["*"] } },
        { sessionKind: "session" },
      ),
    ).toEqual({ ok: false, reason: "unsupported_credential" });
  });
});
