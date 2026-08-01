import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteGatewayCredential,
  getGatewayCredentialsPath,
  readGatewayCredential,
  requireGatewayCredentialToken,
  writeGatewayCredential,
} from "./credentials";

let tmpHome: string;

describe("gateway credentials", () => {
  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "everyapp-creds-"));
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it("writes credentials with 0600 permissions and reads by gateway host", async () => {
    await writeGatewayCredential({
      gatewayUrl: "https://gateway.example.com/",
      token: "eak_secret",
      organizationId: "org-123",
    });

    const credential = await readGatewayCredential(
      "https://gateway.example.com",
    );
    expect(credential).toEqual({
      gatewayUrl: "https://gateway.example.com",
      token: "eak_secret",
      organizationId: "org-123",
    });

    const stat = await fs.stat(getGatewayCredentialsPath());
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("throws actionable help when a credential is missing", async () => {
    await expect(
      requireGatewayCredentialToken("https://gateway.example.com"),
    ).rejects.toThrow("create a Deploy Token");
  });

  it("deletes one gateway credential", async () => {
    await writeGatewayCredential({
      gatewayUrl: "https://gateway.example.com",
      token: "eak_secret",
      organizationId: "org-123",
    });

    await expect(
      deleteGatewayCredential("https://gateway.example.com"),
    ).resolves.toBe(true);
    await expect(
      readGatewayCredential("https://gateway.example.com"),
    ).resolves.toBeNull();
  });
});
