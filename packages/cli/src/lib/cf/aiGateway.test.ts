import { describe, expect, it } from "vitest";
import { ACCOUNT_ID, FakeCloudflare } from "@/test/fakeCloudflare";
import {
  aiGatewayUrl,
  createAiGateway,
  deleteAiGateway,
  ensureAiGateway,
  findAiGateway,
  isValidAiGatewayId,
  listAiGateways,
  updateAiGateway,
} from "./aiGateway";
import { isCfError } from "./errors";
import type { FakeCf } from "./fakeCf";

const ID = "every-acme-notes-ai-gateway";

const callsOf = (cf: FakeCf, action: string) =>
  cf.calls.filter((call) => call.args[0] === "ai-gateway" && call.args[2] === action);

/** The JSON body a recorded `cf ai-gateway gateways create|update` read from its file. */
function bodyOf(cf: FakeCf, action: string): Record<string, unknown> {
  const call = callsOf(cf, action).at(-1)!;
  return JSON.parse(call.files["ai-gateway.json"]!) as Record<string, unknown>;
}

describe("ensureAiGateway", () => {
  it("creates the gateway once with Cloudflare's required settings, and finds it after", async () => {
    const account = new FakeCloudflare();
    await expect(ensureAiGateway(account.cf, { id: ID, accountId: ACCOUNT_ID })).resolves.toEqual({
      id: ID,
      url: `https://gateway.ai.cloudflare.com/v1/${ACCOUNT_ID}/${ID}`,
      created: true,
    });
    expect(bodyOf(account.cf, "create")).toEqual({
      id: ID,
      collect_logs: true,
      cache_ttl: 0,
      cache_invalidate_on_update: false,
      rate_limiting_interval: 0,
      rate_limiting_limit: 0,
      authentication: false,
    });
    // The body file, never flags: nothing of the settings on the command line.
    expect(callsOf(account.cf, "create")[0]!.args).toEqual([
      "ai-gateway",
      "gateways",
      "create",
      "--body",
      "@/fake-cf-files/ai-gateway.json",
    ]);

    await expect(ensureAiGateway(account.cf, { id: ID, accountId: ACCOUNT_ID })).resolves.toEqual({
      id: ID,
      url: aiGatewayUrl(ACCOUNT_ID, ID),
      created: false,
    });
    expect(callsOf(account.cf, "create")).toHaveLength(1);
    expect(account.aiGateways.size).toBe(1);
  });

  it("creates with the logging and caching it is given", async () => {
    const account = new FakeCloudflare();
    await ensureAiGateway(account.cf, {
      id: "everyapp",
      accountId: ACCOUNT_ID,
      collectLogs: false,
      cacheTtl: 300,
    });
    expect(account.aiGateways.get("everyapp")).toMatchObject({
      id: "everyapp",
      collect_logs: false,
      cache_ttl: 300,
      authentication: false,
    });
  });

  it("leaves an existing gateway's settings as they are", async () => {
    const account = new FakeCloudflare();
    await createAiGateway(account.cf, ID, { collectLogs: false });
    await ensureAiGateway(account.cf, { id: ID, accountId: ACCOUNT_ID, collectLogs: true });
    expect(account.aiGateways.get(ID)).toMatchObject({ collect_logs: false });
    expect(callsOf(account.cf, "update")).toEqual([]);
  });

  it("takes the gateway another run created between its lookup and its create", async () => {
    const account = new FakeCloudflare();
    account.cf.override(["ai-gateway", "gateways", "create"], () => {
      account.aiGateways.set(ID, { id: ID, collect_logs: true, cache_ttl: 0 });
      return {
        exitCode: 1,
        stderr: `\n┌ APIError\n│ [7001] An object with this id already exists\n│ 400 Bad Request · HTTP /accounts/${ACCOUNT_ID}/ai-gateway/gateways\n└\n`,
      };
    });
    await expect(ensureAiGateway(account.cf, { id: ID, accountId: ACCOUNT_ID })).resolves.toMatchObject({
      id: ID,
      created: false,
    });
  });

  it.each(["every-acme--notes", "Every-acme", "every_acme", "a".repeat(65)])(
    "refuses the id %s before asking Cloudflare",
    async (id) => {
      const account = new FakeCloudflare();
      await expect(ensureAiGateway(account.cf, { id, accountId: ACCOUNT_ID })).rejects.toThrow(
        "isn't an AI Gateway id Cloudflare takes",
      );
      expect(account.cf.calls).toEqual([]);
    },
  );
});

describe("isValidAiGatewayId", () => {
  it("takes Cloudflare's ids: lowercase letters and digits joined by single hyphens, at most 64", () => {
    expect(isValidAiGatewayId("everyapp")).toBe(true);
    expect(isValidAiGatewayId(ID)).toBe(true);
    expect(isValidAiGatewayId("a".repeat(64))).toBe(true);
    for (const id of ["", "every--app", "-every", "every-", "Every", "every_app", "a".repeat(65)]) {
      expect(isValidAiGatewayId(id)).toBe(false);
    }
  });
});

describe("findAiGateway and createAiGateway", () => {
  it("finds nothing for an id the account doesn't have (Cloudflare's [7002] Not Found)", async () => {
    const account = new FakeCloudflare();
    await expect(findAiGateway(account.cf, ID)).resolves.toBeNull();
  });

  it("fails a create of a taken id as already_exists ([7001])", async () => {
    const account = new FakeCloudflare();
    await createAiGateway(account.cf, ID);
    const error = await createAiGateway(account.cf, ID).catch((caught: unknown) => caught);
    expect(isCfError(error, "already_exists")).toBe(true);
  });
});

describe("updateAiGateway", () => {
  it("changes logging and caching, and sends back every other setting (the update is a PUT)", async () => {
    const account = new FakeCloudflare();
    await createAiGateway(account.cf, ID);
    // Set in the dashboard since.
    Object.assign(account.aiGateways.get(ID)!, {
      authentication: true,
      rate_limiting_limit: 100,
      rate_limiting_interval: 60,
      rate_limiting_technique: "sliding",
    });
    const gateway = (await findAiGateway(account.cf, ID))!;
    await updateAiGateway(account.cf, gateway, { collectLogs: false, cacheTtl: 3600 });
    expect(account.aiGateways.get(ID)).toMatchObject({
      collect_logs: false,
      cache_ttl: 3600,
      authentication: true,
      rate_limiting_limit: 100,
      rate_limiting_interval: 60,
      rate_limiting_technique: "sliding",
    });
    expect(bodyOf(account.cf, "update")).not.toHaveProperty("id");
    expect(callsOf(account.cf, "update")[0]!.args.slice(0, 4)).toEqual([
      "ai-gateway",
      "gateways",
      "update",
      ID,
    ]);
  });
});

describe("deleteAiGateway", () => {
  it("deletes with --force (cf asks otherwise), and a missing one is not_found", async () => {
    const account = new FakeCloudflare();
    await createAiGateway(account.cf, ID);
    await deleteAiGateway(account.cf, ID);
    expect(account.aiGateways.size).toBe(0);
    expect(callsOf(account.cf, "delete")[0]!.args).toEqual([
      "ai-gateway",
      "gateways",
      "delete",
      ID,
      "--force",
    ]);
    const error = await deleteAiGateway(account.cf, ID).catch((caught: unknown) => caught);
    expect(isCfError(error, "not_found")).toBe(true);
  });
});

describe("listAiGateways", () => {
  it("reads every page of the gateways whose id matches", async () => {
    const account = new FakeCloudflare();
    for (let index = 0; index < 25; index += 1) {
      await createAiGateway(account.cf, `every-acme-app${index}-ai`);
    }
    await createAiGateway(account.cf, "everyapp");
    await createAiGateway(account.cf, "my-own");
    const listed = await listAiGateways(account.cf, "every-");
    expect(listed.map((gateway) => gateway.id).sort()).toEqual(
      Array.from({ length: 25 }, (_, index) => `every-acme-app${index}-ai`).sort(),
    );
    expect(callsOf(account.cf, "list")[0]!.args).toEqual([
      "ai-gateway",
      "gateways",
      "list",
      "--search",
      "every-",
      "--per-page",
      "20",
      "--page",
      "1",
    ]);
  });

  it("stops when a page brings nothing new, as from an API that ignores pages", async () => {
    const account = new FakeCloudflare();
    const page = Array.from({ length: 20 }, (_, index) => ({ id: `every-${index}` }));
    account.cf.override(["ai-gateway", "gateways", "list"], { stdout: JSON.stringify(page) });
    expect(await listAiGateways(account.cf, "every-")).toHaveLength(20);
    expect(callsOf(account.cf, "list")).toHaveLength(2);
  });
});
