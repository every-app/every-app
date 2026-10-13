import { describe, expect, it, vi } from "vitest";
import { isMcpDcrEnabled, isMcpOauthEnabled } from "./oauth-flag";

describe("isMcpOauthEnabled", () => {
  it("is on unless the switch says off", () => {
    for (const value of [
      undefined,
      "",
      " ",
      "true",
      "TRUE",
      "1",
      "on",
      "yes ",
    ]) {
      expect(isMcpOauthEnabled({ MCP_OAUTH_ENABLED: value }), `${value}`).toBe(
        true,
      );
    }
    for (const value of ["false", "0", "off", "No"]) {
      expect(isMcpOauthEnabled({ MCP_OAUTH_ENABLED: value }), value).toBe(
        false,
      );
    }
  });

  it("fails closed on a value that is neither, and says so once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(isMcpOauthEnabled({ MCP_OAUTH_ENABLED: "disabled" })).toBe(false);
    expect(isMcpOauthEnabled({ MCP_OAUTH_ENABLED: "Disabled" })).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(
      '"evt":"mcp.oauth.flag_unrecognized"',
    );
    warn.mockRestore();
  });
});

describe("isMcpDcrEnabled", () => {
  it("is on unless its own switch says off", () => {
    expect(isMcpDcrEnabled({})).toBe(true);
    expect(isMcpDcrEnabled({ MCP_DCR_ENABLED: "true" })).toBe(true);
    expect(isMcpDcrEnabled({ MCP_DCR_ENABLED: "false" })).toBe(false);
    expect(isMcpDcrEnabled({ MCP_DCR_ENABLED: "Off" })).toBe(false);
  });

  it("fails closed on a value that is neither, naming the switch", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(isMcpDcrEnabled({ MCP_DCR_ENABLED: "disabled" })).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
      evt: "mcp.oauth.flag_unrecognized",
      name: "MCP_DCR_ENABLED",
    });
    warn.mockRestore();
  });
});
