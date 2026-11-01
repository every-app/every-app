import { describe, expect, it } from "vitest";
import {
  AUDIT_GROUP_LABELS,
  auditActorLabel,
  auditActorOf,
  auditSubjectLabel,
  auditSubjectOf,
  auditTypeCondition,
  auditTypeGroups,
  auditTypeLabel,
  auditTypeMatches,
} from "./audit.js";
import { EVENT_TYPES } from "./events.js";

describe("the audit log's shared reading of an event", () => {
  it("names the actor the way each surface shows it", () => {
    expect(
      auditActorLabel(
        auditActorOf(
          JSON.stringify({
            kind: "user",
            id: "u1",
            email: "jo@acme.example",
            name: "Jo",
          }),
        ),
      ),
    ).toBe("Jo");
    expect(
      auditActorLabel(
        auditActorOf({ kind: "user", id: "u1", email: "jo@acme.example" }),
      ),
    ).toBe("jo@acme.example");
    expect(
      auditActorLabel(
        auditActorOf({ kind: "agent", id: "mcpc_1", name: "Claude" }),
      ),
    ).toBe("agent · Claude");
    expect(
      auditActorLabel(
        auditActorOf({
          kind: "operator",
          id: "cf:1",
          email: "ben@acme.example",
        }),
      ),
    ).toBe("CLI · ben@acme.example");
    expect(auditActorLabel(auditActorOf({ kind: "app", id: "crm" }))).toBe(
      "app · crm",
    );
    expect(auditActorLabel(auditActorOf({ kind: "gateway" }))).toBe("Gateway");
    expect(auditActorOf("not json")).toEqual({
      kind: "gateway",
      id: null,
      email: null,
      name: null,
    });
  });

  it("labels a type by the catalogue's description, and an app's own event as an app event", () => {
    expect(auditTypeLabel("member.joined")).toBe(
      "Someone joined the workspace",
    );
    expect(auditTypeLabel("app.crm.invoice.paid")).toBe(
      "App event: invoice.paid",
    );
    expect(auditTypeLabel("something.new")).toBe("something.new");
  });

  it("picks the subject from the data by the catalogue's keys, never a value", () => {
    const needsSetup = auditSubjectOf("app.needs_setup", {
      app: { id: "crm", rowId: "row-1", name: "CRM" },
      unmet: ["OPENAI_API_KEY"],
    });
    expect(needsSetup).toEqual({
      app: { id: "crm", name: "CRM" },
      settings: ["OPENAI_API_KEY"],
    });
    expect(auditSubjectLabel(needsSetup)).toBe("CRM · OPENAI_API_KEY");
    expect(
      auditSubjectOf("member.invited", {
        invitation: {
          id: "inv",
          email: "pat@acme.example",
          role: "member",
          expiresAt: "x",
        },
      }),
    ).toEqual({ invitation: { email: "pat@acme.example", role: "member" } });
    expect(
      auditSubjectOf("mcp_app.added", {
        app: { id: "dataforseo", rowId: "r", name: "DataForSEO" },
      }),
    ).toEqual({ mcpApp: { id: "dataforseo", name: "DataForSEO" } });
    expect(auditSubjectOf("app.crm.invoice.paid", { amount: 12 })).toEqual({
      app: { id: "crm", name: null },
    });
    expect(
      auditSubjectLabel(
        auditSubjectOf("tool.blocked", {
          tool: "crm_delete",
          user: { id: "u1", email: "jo@acme.example", name: null },
          client: { kind: "oauth", name: "Claude", id: "mcpc_1" },
        }),
      ),
    ).toBe("jo@acme.example · crm_delete · Claude");
    expect(auditSubjectOf("token.created", { name: "laptop" })).toEqual({
      token: "laptop",
    });
  });

  it("leaves ping and tool calls out by default, and in when asked for", () => {
    expect(auditTypeMatches("member.joined", undefined)).toBe(true);
    expect(auditTypeMatches("tool.blocked", undefined)).toBe(false);
    expect(auditTypeMatches("ping", undefined)).toBe(false);
    expect(auditTypeMatches("tool.blocked", "tool.*")).toBe(true);
    expect(auditTypeMatches("tool.blocked", "*")).toBe(true);
    expect(auditTypeMatches("member.joined", "member.removed")).toBe(false);
    expect(auditTypeCondition("member.*")).toEqual({
      op: "prefix",
      value: "member.",
    });
    expect(auditTypeCondition("member.joined")).toEqual({
      op: "eq",
      value: "member.joined",
    });
    expect(auditTypeCondition("*")).toBeNull();
  });

  it("groups the catalogue for the type filter, every type once, ping left out", () => {
    const groups = auditTypeGroups();
    const listed = groups.flatMap((group) =>
      group.types.map((info) => info.type),
    );
    expect(listed).toEqual(
      EVENT_TYPES.filter((info) => info.type !== "ping").map(
        (info) => info.type,
      ),
    );
    for (const group of groups) {
      expect(group.pattern).toBe(`${group.group}.*`);
      expect(group.label).toBe(AUDIT_GROUP_LABELS[group.group] ?? group.label);
      expect(group.label).toMatch(/^[A-Z]/);
    }
  });
});
