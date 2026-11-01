/**
 * AI Gateway (`resources.aiGateway`), live on the test account: the
 * library (lib/cf/aiGateway.ts) creates a gateway once and finds it the
 * second time, sets its logging and caching back with an update that
 * keeps every other setting, a prebuilt Worker binds it as the json
 * binding the deploy installs and reads back with it, and the Worker and
 * the gateway are deleted. Skipped without EVERYAPP_LIVE_PROVISIONERS=1
 * (see ./live.ts). What it prints never holds the account id.
 */
import { expect, it } from "vitest";
import {
  aiGatewayUrl,
  deleteAiGateway,
  ensureAiGateway,
  findAiGateway,
  listAiGateways,
  updateAiGateway,
} from "@/lib/cf/aiGateway";
import { isCfError } from "@/lib/cf/errors";
import { getWorkerDeployment } from "@/lib/cf/workers";
import {
  deleteWorkerQuietly,
  describeLive,
  liveAccount,
  LIVE_PREFIX,
  readWorkerBindings,
  uploadPrebuilt,
} from "./live";

/** The gateway and the Worker binding it share the name: one hyphen, as every gateway id. */
const ID = `${LIVE_PREFIX}ai-gateway`;
const WORKER = `${LIVE_PREFIX}ai-gateway`;

describeLive("AI Gateway, live", () => {
  it("creates a gateway once, updates it, binds it on a Worker, and deletes both", async () => {
    const live = await liveAccount();
    const shown = (value: unknown) => JSON.stringify(value, null, 2).replaceAll(live.accountId, "<account>");
    const deleteGateway = async () => {
      try {
        await deleteAiGateway(live.cf, ID);
      } catch (error) {
        if (!isCfError(error, "not_found")) throw error;
      }
    };
    // What an earlier run that stopped may have left.
    await deleteGateway();
    try {
      const first = await ensureAiGateway(live.cf, { id: ID, accountId: live.accountId });
      expect(first).toEqual({ id: ID, url: aiGatewayUrl(live.accountId, ID), created: true });
      const created = (await findAiGateway(live.cf, ID))!;
      console.log(`cf ai-gateway gateways get ${ID}:\n${shown(created)}`);
      expect(created).toMatchObject({ id: ID, collect_logs: true, cache_ttl: 0, authentication: false });

      const second = await ensureAiGateway(live.cf, { id: ID, accountId: live.accountId });
      expect(second).toEqual({ ...first, created: false });
      expect((await findAiGateway(live.cf, ID))!["created_at"]).toBe(created["created_at"]);

      const listed = await listAiGateways(live.cf, LIVE_PREFIX);
      expect(listed.map((gateway) => gateway.id)).toContain(ID);

      await updateAiGateway(live.cf, created, { collectLogs: false, cacheTtl: 60 });
      const updated = (await findAiGateway(live.cf, ID))!;
      console.log(`after updateAiGateway(collectLogs: false, cacheTtl: 60):\n${shown(updated)}`);
      expect(updated).toMatchObject({ collect_logs: false, cache_ttl: 60 });
      // A PUT that sent every setting back: nothing else moved.
      const { collect_logs: _a, cache_ttl: _b, modified_at: _c, ...before } = created;
      const { collect_logs: _d, cache_ttl: _e, modified_at: _f, ...after } = updated;
      expect(after).toEqual(before);

      const value = { id: ID, accountId: live.accountId, url: first.url };
      await uploadPrebuilt(live, {
        workerName: WORKER,
        env: { AI_GATEWAY: { type: "json", value } },
      });
      const bindings = await readWorkerBindings(live, WORKER);
      const binding = bindings.find((entry) => entry.name === "AI_GATEWAY");
      console.log(`the Worker's AI_GATEWAY binding, read back:\n${shown(binding)}`);
      expect(binding).toMatchObject({ name: "AI_GATEWAY", type: "json", json: value });
    } finally {
      await deleteWorkerQuietly(live, WORKER);
      await deleteGateway();
    }
    expect(await getWorkerDeployment(live.cf, WORKER)).toBeNull();
    expect(await findAiGateway(live.cf, ID)).toBeNull();
  }, 300_000);
});
