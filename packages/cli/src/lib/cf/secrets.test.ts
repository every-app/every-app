import { describe, expect, it } from "vitest";
import { FakeCloudflare } from "@/test/fakeCloudflare";
import { assertReplaceable } from "./deploy";
import { listWorkerSecrets, patchWorkerSecrets } from "./secrets";
import { getWorkerDeployment } from "./workers";

const seed = (account: FakeCloudflare, name: string) =>
  account.workers.set(name, {
    versions: [`${name}-version-1`],
    config: {},
    secrets: { GITHUB_TOKEN: "old", OPENAI_API_KEY: "k" },
  });

describe("patchWorkerSecrets", () => {
  it("sets and removes secrets in one new version, with the values in a private file", async () => {
    const account = new FakeCloudflare();
    seed(account, "every-acme-todo");
    await patchWorkerSecrets(account.cf, "every-acme-todo", {
      GITHUB_TOKEN: "new",
      DATAFORSEO_API_KEY: "d",
      OPENAI_API_KEY: null,
    });
    expect(account.workers.get("every-acme-todo")!.secrets).toEqual({
      GITHUB_TOKEN: "new",
      DATAFORSEO_API_KEY: "d",
    });
    expect(account.workers.get("every-acme-todo")!.versions).toHaveLength(2);
    const call = account.cf.calls.find((c) => c.args.includes("bulk"))!;
    expect(call.args).not.toContain("new");
    expect(call.args).not.toContain("d");
    expect(call.args).not.toContain("--file");
    expect(call.args[call.args.indexOf("--body") + 1]).toMatch(/^@.*secrets\.json$/);
    expect(JSON.parse(call.files["secrets.json"]!)).toEqual({
      secrets: {
        GITHUB_TOKEN: { name: "GITHUB_TOKEN", type: "secret_text", text: "new" },
        DATAFORSEO_API_KEY: { name: "DATAFORSEO_API_KEY", type: "secret_text", text: "d" },
        OPENAI_API_KEY: null,
      },
    });
    await expect(listWorkerSecrets(account.cf, "every-acme-todo")).resolves.toEqual([
      "DATAFORSEO_API_KEY",
      "GITHUB_TOKEN",
    ]);
  });

  it("makes a version the replace check refuses until it is recorded", async () => {
    const account = new FakeCloudflare();
    seed(account, "every-acme-todo");
    await patchWorkerSecrets(account.cf, "every-acme-todo", { GITHUB_TOKEN: "new" });
    const serving = await getWorkerDeployment(account.cf, "every-acme-todo");
    expect(serving?.versionId).toBe("every-acme-todo-api-1");
    // The rerun is for a person at a terminal: built without the run's --json.
    const argv = process.argv;
    process.argv = [...argv.slice(0, 2), "secret", "set", "GITHUB_TOKEN", "--json"];
    try {
      await expect(
        assertReplaceable({
          cf: account.cf,
          workerName: "every-acme-todo",
          shownAs: "todo",
          recordedVersionIds: ["every-acme-todo-version-1"],
          interactive: false,
          change: { question: "Set GITHUB_TOKEN on it anyway?", effect: "Setting it makes a new version." },
        }),
      ).rejects.toMatchObject({
        action: "rerun_interactive",
        message: expect.stringMatching(/^todo was changed outside everyapp; confirm in a terminal/),
        rerun: "pnpm everyapp secret set GITHUB_TOKEN",
        rerunNote: "in a terminal",
        data: { needsTerminal: true },
      });
    } finally {
      process.argv = argv;
    }
    await expect(
      assertReplaceable({
        cf: account.cf,
        workerName: "every-acme-todo",
        shownAs: "todo",
        recordedVersionIds: ["every-acme-todo-version-1", serving!.versionId!],
        interactive: false,
        change: { question: "Set GITHUB_TOKEN on it anyway?", effect: "Setting it makes a new version." },
      }),
    ).resolves.toBeUndefined();
  });

  it("refuses a Worker that doesn't exist", async () => {
    const account = new FakeCloudflare();
    await expect(
      patchWorkerSecrets(account.cf, "missing", { GITHUB_TOKEN: "x" }),
    ).rejects.toThrow(/does not exist/);
  });
});
