/**
 * The update a command offers when the Gateway is older than this
 * everyapp: who is asked, what Yes and No do, and what a failed update
 * leaves.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EveryAppError } from "@/lib/errors";
import { thisCommand } from "@/lib/output/command";
import { createNdjsonSink, type EventSink } from "@/lib/output/events";
import { runCommand } from "@/lib/output/run";
import { offerGatewayUpdate, type OfferUpdateSeams } from "./offerUpdate";

const GATEWAY = { gatewayUrl: "https://apps.example.com", accountId: "account-1" };

const outdated = (data: Record<string, unknown> = GATEWAY) =>
  new EveryAppError("GATEWAY_OUTDATED", "The Gateway is older than this everyapp\nIts database doesn't have migration 0035 yet.", {
    rerun: "everyapp update",
    rerunNote: "then run this again",
    data: { needs: "0035", ...data },
  });

const out = (): EventSink => createNdjsonSink(() => undefined);

/** A person at a terminal who answers `answer`, and an update that works. */
function seams(answer: boolean, overrides: OfferUpdateSeams = {}) {
  const confirm = vi.fn(async () => answer);
  const update = vi.fn(async () => undefined);
  return { confirm, update, seams: { canPrompt: () => true, confirm, update, ...overrides } };
}

describe("the update offered for an outdated Gateway", () => {
  it("asks a person at a terminal, with which Gateway and what an update does, and updates on Yes", async () => {
    const { confirm, update, seams: asked } = seams(true);

    await expect(offerGatewayUpdate(outdated(), {}, out(), asked)).resolves.toBe(true);

    expect(confirm).toHaveBeenCalledWith("Update it now?", [
      "The Gateway at apps.example.com is older than this everyapp.",
      "Updating migrates its database (with a restore point) and deploys this everyapp's Gateway.",
    ]);
    expect(update).toHaveBeenCalledWith(GATEWAY, expect.anything(), false);
  });

  it("updates nothing on No", async () => {
    const { update, seams: asked } = seams(false);

    await expect(offerGatewayUpdate(outdated(), {}, out(), asked)).resolves.toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it.each<[string, { json?: boolean; yes?: boolean }, OfferUpdateSeams]>([
    ["under --json", { json: true }, {}],
    ["with --yes", { yes: true }, {}],
    ["with no terminal", {}, { canPrompt: () => false }],
  ])("asks nobody %s", async (_, flags, override) => {
    const { confirm, update, seams: asked } = seams(true, override);
    // --json is what canPromptInTerminal refuses; the seam stands in for the terminal alone.
    const canPrompt = override.canPrompt ?? ((json: boolean) => !json);

    await expect(offerGatewayUpdate(outdated(), flags, out(), { ...asked, canPrompt })).resolves.toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("offers nothing for another error, or an outdated Gateway it can't name", async () => {
    const { confirm, seams: asked } = seams(true);

    await expect(offerGatewayUpdate(new EveryAppError("GATEWAY_NOT_FOUND", "No Gateway"), {}, out(), asked)).resolves.toBe(false);
    await expect(offerGatewayUpdate(new Error("boom"), {}, out(), asked)).resolves.toBe(false);
    await expect(offerGatewayUpdate(outdated({ gatewayUrl: undefined }), {}, out(), asked)).resolves.toBe(false);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("fails with the update's own error when the update fails", async () => {
    const failure = new EveryAppError("MIGRATION_FAILED", "A Gateway migration failed");
    const { seams: asked } = seams(true, { update: async () => Promise.reject(failure) });

    await expect(offerGatewayUpdate(outdated(), {}, out(), asked)).rejects.toBe(failure);
  });
});

describe("a command run against an outdated Gateway", () => {
  afterEach(() => {
    process.exitCode = undefined;
  });

  /** A command whose first try finds the Gateway outdated. */
  function command() {
    let tries = 0;
    const events: Array<Record<string, unknown>> = [];
    const body = vi.fn(async (sink: EventSink) => {
      tries += 1;
      if (tries === 1) throw outdated();
      sink.emit({ type: "done", message: "Deployed" });
    });
    return { body, events };
  }

  it("starts again after the update a person said Yes to", async () => {
    const { body } = command();
    const { update, seams: asked } = seams(true);

    await runCommand({}, body, asked);

    expect(update).toHaveBeenCalledTimes(1);
    expect(body).toHaveBeenCalledTimes(2);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("stops with GATEWAY_OUTDATED, as before, on No, under --json and with --yes", async () => {
    for (const [flags, answer] of [
      [{}, false],
      [{ json: true }, true],
      [{ yes: true }, true],
    ] as const) {
      const { body } = command();
      const { update, seams: asked } = seams(answer);
      const lines: string[] = [];
      const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        lines.push(String(chunk));
        return true;
      });
      const problems = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        await runCommand(flags, body, { ...asked, canPrompt: (json) => !json });
      } finally {
        write.mockRestore();
        problems.mockRestore();
      }

      expect(update).not.toHaveBeenCalled();
      expect(body).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBe(1);
      if ("json" in flags) {
        // One error event, and nothing else on stdout.
        const events = lines.join("").trim().split("\n").map((line) => JSON.parse(line));
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          type: "error",
          code: "GATEWAY_OUTDATED",
          data: { rerun: "everyapp update", needs: "0035", ...GATEWAY },
        });
      }
    }
  });

  it("doesn't start the command when the update fails, and reports the update's error", async () => {
    const { body } = command();
    const { seams: asked } = seams(true, {
      update: async () => Promise.reject(new EveryAppError("MIGRATION_FAILED", "A Gateway migration failed")),
    });
    const said: string[] = [];
    const problems = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      said.push(String(chunk));
      return true;
    });
    try {
      await runCommand({}, body, asked);
    } finally {
      problems.mockRestore();
    }

    expect(body).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
    // The update's failure is the run's; the outdated Gateway isn't said again.
    expect(said.join("")).toContain("A Gateway migration failed");
    expect(said.join("")).not.toContain("older than this everyapp");
  });
});

describe("what the offered update suggests running again", () => {
  it("is the update, not the command the person typed", async () => {
    const { asCommand } = await import("@/lib/output/command");

    const during = await asCommand(["update", "--gateway", "https://apps.example.com"], async () =>
      thisCommand(["--force-dns"]),
    );

    expect(during).toMatch(/everyapp update --gateway https:\/\/apps\.example\.com --force-dns$/);
    // Afterwards it is this process's own arguments again.
    expect(thisCommand()).not.toContain("--gateway https://apps.example.com");
  });
});
