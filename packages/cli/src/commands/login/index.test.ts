import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeCf } from "@/lib/cf/fakeCf";
import { createHumanSink, createNdjsonSink } from "@/lib/output/events";
import { logInToCloudflare } from "./index";

const LOGGED_OUT = JSON.stringify({ authenticated: false });
const LOGGED_IN = JSON.stringify({
  authenticated: true,
  email: "ben@example.com",
  accounts: [{ id: "acct-1", name: "Ben Senescu" }],
});

afterEach(() => vi.unstubAllEnvs());

/** A person's screen: stdout, without colors. */
function screen() {
  let text = "";
  const out = createHumanSink({ write: (chunk) => (text += chunk), writeProblem: (chunk) => (text += chunk) });
  return { out, text: () => stripVTControlCharacters(text) };
}

describe("everyapp login", () => {
  it("says who is logged in already, and logs nobody in", async () => {
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
    const cf = new FakeCf().on(["auth", "whoami"], { stdout: LOGGED_IN });
    const { out, text } = screen();

    await logInToCloudflare({ out, interactive: true, cf });

    expect(text()).toBe("Already logged in to Cloudflare as ben@example.com\n");
    expect(cf.calls.map((call) => call.args.join(" "))).toEqual(["auth whoami"]);
    expect(out.exitCode).toBe(0);
  });

  it("runs cf's login at a terminal, then names the account", async () => {
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
    let loggedIn = false;
    const cf = new FakeCf()
      .on(["auth", "whoami"], () => ({ stdout: loggedIn ? LOGGED_IN : LOGGED_OUT }))
      .on(["auth", "login"], () => ((loggedIn = true), {}));
    const { out, text } = screen();

    await logInToCloudflare({ out, interactive: true, cf });

    expect(cf.calls.map((call) => [call.args.join(" "), call.mode])).toEqual([
      ["auth whoami", "json"],
      ["auth login", "interactive"],
      ["auth whoami", "json"],
    ]);
    expect(text()).toBe("Logged in to Cloudflare as ben@example.com ✓\n");
  });

  it("hands out cf's device link and code without a terminal, and waits for the approval", async () => {
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
    let loggedIn = false;
    const cf = new FakeCf()
      .on(["auth", "whoami"], () => ({ stdout: loggedIn ? LOGGED_IN : LOGGED_OUT }))
      .on(["auth", "login"], () => {
        loggedIn = true;
        return {
          stdout: "please visit: https://dash.cloudflare.com/oauth2/device\nand enter the code: WXYZ-1234\n",
        };
      });
    const lines: Array<Record<string, unknown>> = [];
    const out = createNdjsonSink((line) => lines.push(JSON.parse(line)));

    await logInToCloudflare({ out, interactive: false, cf });

    expect(lines.map(({ type, step, status }) => [type, step, status])).toEqual([
      ["action_required", "cloudflare.login", undefined],
      ["step", "cloudflare.login", "ok"],
    ]);
    expect(lines[0]).toMatchObject({
      action: "cloudflare_login",
      data: { url: "https://dash.cloudflare.com/oauth2/device", code: "WXYZ-1234", waiting: true },
    });
    expect(lines[1]).toMatchObject({ data: { email: "ben@example.com" } });
    expect(cf.calls[1]!.args).toEqual(["auth", "login", "--no-browser"]);
  });
});
