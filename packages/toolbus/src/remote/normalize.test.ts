import { describe, expect, it } from "vitest";
import type { RemoteMcpBlock } from "@every-app/sdk/internal";
import type { UpstreamTool } from "./client";
import { normalizeRemoteCatalog, riskHintOf } from "./normalize";

const block: Pick<RemoteMcpBlock, "risk" | "tools"> = {
  risk: "annotations",
  tools: {},
};

const upstream: UpstreamTool[] = [
  {
    name: "getUser",
    title: "Get user",
    description: "Read one user.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  {
    name: "deleteUser",
    description: "Delete a user.",
    inputSchema: { type: "object", properties: { id: { type: "string" } } },
    annotations: { destructiveHint: true },
  },
  {
    name: "send-mail",
    description: "Send mail.",
    inputSchema: { type: "object" },
    outputSchema: { type: "object", properties: { id: { type: "string" } } },
    annotations: { openWorldHint: true },
  },
  { name: "ping", inputSchema: { type: "object" } },
];

describe("normalizeRemoteCatalog", () => {
  it("normalizes names, refuses collisions, applies overrides and maps risks conservatively", () => {
    const out = normalizeRemoteCatalog("treg", "Treg", upstream, block);
    expect(out.tools.map((tool) => [tool.name, tool.risk])).toEqual([
      ["delete_user", "destructive"],
      ["get_user", "read"],
      ["ping", "write"],
      ["send_mail", "write"],
    ]);
    expect(out.map.get("get_user")).toBe("getUser");
    expect(out.map.get("send_mail")).toBe("send-mail");
    const getUser = out.tools.find((tool) => tool.name === "get_user")!;
    expect(getUser).toMatchObject({
      title: "Get user",
      description: "Read one user.",
      annotations: { idempotentHint: true },
    });
    expect(getUser.inputSchema).toEqual({
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    });
    const sendMail = out.tools.find((tool) => tool.name === "send_mail")!;
    expect(sendMail.outputSchema).toEqual({
      type: "object",
      properties: { id: { type: "string" } },
    });
    expect(sendMail.annotations).toEqual({ openWorldHint: true });
    // A tool with no description gets one; one with no object schema gets a permissive one.
    const ping = out.tools.find((tool) => tool.name === "ping")!;
    expect(ping.description).toBe("The ping tool of Treg.");
    expect(
      out.records.map((record) => [
        record.upstreamName,
        record.localName,
        record.riskHint,
        record.source,
        record.listed,
      ]),
    ).toEqual([
      ["deleteUser", "delete_user", "destructive", "hint", true],
      ["getUser", "get_user", "read", "hint", true],
      ["ping", "ping", "unknown", "default", true],
      ["send-mail", "send_mail", "unknown", "default", true],
    ]);
    expect(out.warnings).toEqual([]);

    const collided = normalizeRemoteCatalog(
      "treg",
      "Treg",
      [
        { name: "getUser", inputSchema: { type: "object" } },
        { name: "get_user", inputSchema: { type: "object" } },
        { name: "???", inputSchema: { type: "object" } },
        { name: "getUser", inputSchema: { type: "object" } },
      ],
      block,
    );
    expect(collided.tools).toEqual([]);
    expect(
      collided.records.map((record) => [
        record.upstreamName,
        record.listed,
        record.problem,
      ]),
    ).toEqual([
      [
        "???",
        false,
        "its name can't be made a tool name (letters, digits and underscores)",
      ],
      ["getUser", false, '2 tools normalize to "get_user" (getUser, get_user)'],
      [
        "get_user",
        false,
        '2 tools normalize to "get_user" (getUser, get_user)',
      ],
    ]);
    expect(collided.warnings).toContain(
      "getUser: skipped, the server listed it twice",
    );

    const overridden = normalizeRemoteCatalog("treg", "Treg", upstream, {
      risk: "read",
      tools: { deleteUser: { risk: "write" }, ping: { enabled: false } },
    });
    expect(overridden.tools.map((tool) => [tool.name, tool.risk])).toEqual([
      ["delete_user", "write"],
      ["get_user", "read"],
      ["send_mail", "read"],
    ]);
    const off = overridden.records.find(
      (record) => record.upstreamName === "ping",
    )!;
    expect(off).toMatchObject({
      listed: false,
      problem: "turned off by the operator",
      risk: "read",
      source: "app",
    });
    expect(
      overridden.records.find((record) => record.upstreamName === "deleteUser")!
        .source,
    ).toBe("override");
  });

  it("leaves out a tool whose server name can't travel in a request header, and caps a collision's text", () => {
    const out = normalizeRemoteCatalog(
      "treg",
      "Treg",
      [
        { name: "get user", inputSchema: { type: "object" } },
        { name: "ünïcode_tool", inputSchema: { type: "object" } },
        ...Array.from({ length: 6 }, (_, index) => ({
          name: `dup${"_".repeat(index + 1)}x`,
          inputSchema: { type: "object" },
        })),
      ],
      block,
    );
    expect(out.tools).toEqual([]);
    const spaced = out.records.find(
      (record) => record.upstreamName === "get user",
    )!;
    expect(spaced).toMatchObject({
      listed: false,
      localName: "get_user",
      problem: expect.stringMatching(/request header/),
    });
    const dup = out.records.find((record) => record.upstreamName === "dup_x")!;
    expect(dup.problem).toMatch(
      /^6 tools normalize to "dup_x" \(dup_x, dup__x, dup___x and 3 more\)$/,
    );
  });

  it("keeps a long local name within the client limit and cuts long titles and descriptions", () => {
    const long = "a".repeat(60);
    const out = normalizeRemoteCatalog(
      "a-long-app-id-here",
      "App",
      [
        {
          name: long,
          title: "t".repeat(150),
          description: "d".repeat(3000),
          inputSchema: { type: "object" },
        },
      ],
      block,
    );
    const tool = out.tools[0]!;
    expect(`a-long-app-id-here_${tool.name}`.length).toBeLessThanOrEqual(64);
    expect(tool.title!.length).toBe(100);
    expect(tool.description.length).toBe(2048);
    expect(out.map.get(tool.name)).toBe(long);
  });

  it("reads the hint alone", () => {
    expect(riskHintOf(undefined)).toBe("unknown");
    expect(riskHintOf({})).toBe("unknown");
    expect(riskHintOf({ readOnlyHint: true })).toBe("read");
    expect(riskHintOf({ destructiveHint: true })).toBe("destructive");
    expect(riskHintOf({ readOnlyHint: false })).toBe("write");
    expect(riskHintOf({ destructiveHint: false })).toBe("write");
    expect(riskHintOf({ readOnlyHint: "yes" })).toBe("unknown");
  });
});
