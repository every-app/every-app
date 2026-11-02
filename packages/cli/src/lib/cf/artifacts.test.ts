/**
 * `delete --purge`'s Artifacts step against the fake account
 * (test/fakeCloudflare.ts): a namespace's repos, then the namespace.
 */
import { describe, expect, it } from "vitest";
import { FakeCloudflare } from "@/test/fakeCloudflare";
import { isCfError } from "./errors";
import { purgeArtifactsNamespace } from "./artifacts";

const NS = "every-acme-birds--memory";

describe("purgeArtifactsNamespace", () => {
  it("deletes every repo, then the namespace, and leaves other namespaces alone", async () => {
    const account = new FakeCloudflare();
    for (const repo of ["agent-1", "agent-2", "principles"]) account.addArtifactsRepo(NS, repo);
    account.addArtifactsRepo("every-acme-other--memory", "keep-me");

    await expect(purgeArtifactsNamespace(account.cf, NS)).resolves.toEqual(["agent-1", "agent-2", "principles"]);

    expect(account.artifacts.has(NS)).toBe(false);
    expect(account.artifacts.get("every-acme-other--memory")).toEqual(new Set(["keep-me"]));
    const deletes = account.cf.calls.filter((call) => call.args[0] === "artifacts" && call.args.includes("delete"));
    expect(deletes.length).toBe(4);
    for (const call of deletes) expect(call.args).toContain("--force");
  });

  it("lists again until no new repo appears, past one page", async () => {
    const account = new FakeCloudflare();
    for (let i = 0; i < 205; i += 1) account.addArtifactsRepo(NS, `repo-${String(i).padStart(3, "0")}`);

    await expect(purgeArtifactsNamespace(account.cf, NS)).resolves.toHaveLength(205);
    expect(account.artifacts.has(NS)).toBe(false);
  });

  it("throws not_found for a namespace no repo was ever made in", async () => {
    const account = new FakeCloudflare();
    const error = await purgeArtifactsNamespace(account.cf, NS).catch((caught: unknown) => caught);
    expect(isCfError(error, "not_found")).toBe(true);
  });

  it("throws, not not_found, when a repo the list missed keeps the namespace from being deleted", async () => {
    const account = new FakeCloudflare();
    account.addArtifactsRepo(NS, "agent-1");
    account.addArtifactsRepo(NS, "late");
    account.artifactsListLag.add("late");

    const error = await purgeArtifactsNamespace(account.cf, NS).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(isCfError(error, "not_found")).toBe(false);
    expect(account.artifacts.get(NS)).toEqual(new Set(["late"]));
  });
});
