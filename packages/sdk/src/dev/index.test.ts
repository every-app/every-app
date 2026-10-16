import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEV_ISSUER,
  DEV_PRIVATE_KEY_PEM,
  DEV_PUBLIC_KEY_PEM,
  IDENTITY_DEV_KEY_ID,
} from "./index";
import {
  DEV_ENV,
  DEV_ISSUER as WORKER_DEV_ISSUER,
  IDENTITY_HEADER,
  ISSUER_ENV,
  PUBLIC_KEYS_ENV,
  IdentityError,
  getIdentityFromRequest,
  mintIdentityJwt,
} from "../internal/index";

const subject = {
  sub: "dev-user",
  email: "dev@everyapp.localhost",
  orgId: "dev-org",
  orgRole: "owner",
};

function request(token: string): Request {
  return new Request("http://todo.localhost:8787/", {
    headers: { [IDENTITY_HEADER]: token },
  });
}

describe("@every-app/sdk/dev", () => {
  it("names the same issuer the Worker side checks", () => {
    expect(DEV_ISSUER).toBe(WORKER_DEV_ISSUER);
  });

  it("signs dev identities a dev Worker verifies, and nothing else does", async () => {
    const token = await mintIdentityJwt(DEV_PRIVATE_KEY_PEM, {
      subject,
      audience: "todo",
      issuer: DEV_ISSUER,
      keyId: IDENTITY_DEV_KEY_ID,
    });
    const env = {
      [PUBLIC_KEYS_ENV]: JSON.stringify([DEV_PUBLIC_KEY_PEM]),
      [ISSUER_ENV]: DEV_ISSUER,
    };

    const { user } = await getIdentityFromRequest(request(token), {
      audience: "todo",
      env: { ...env, [DEV_ENV]: "1" },
    });
    expect(user?.email).toBe(subject.email);

    await expect(
      getIdentityFromRequest(request(token), { audience: "todo", env }),
    ).rejects.toBeInstanceOf(IdentityError);
  });

  it("is never loaded by the Worker side of the SDK", () => {
    const src = path.dirname(path.dirname(new URL(import.meta.url).pathname));
    for (const dir of ["server", "internal"]) {
      for (const file of fs.readdirSync(path.join(src, dir))) {
        if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
        const source = fs.readFileSync(path.join(src, dir, file), "utf-8");
        expect(source, `${dir}/${file}`).not.toMatch(/from\s+"\.\.\/dev\//);
      }
    }
  });
});
