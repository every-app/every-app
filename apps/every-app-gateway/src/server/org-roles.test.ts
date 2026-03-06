import { describe, expect, it } from "vitest";
import { resolvePrimaryOrganizationRole } from "./org-roles";

describe("org-roles", () => {
  describe("resolvePrimaryOrganizationRole", () => {
    it("returns highest-priority role from comma-delimited values", () => {
      expect(resolvePrimaryOrganizationRole("owner")).toBe("owner");
      expect(resolvePrimaryOrganizationRole("admin")).toBe("admin");
      expect(resolvePrimaryOrganizationRole("member")).toBe("member");
      expect(resolvePrimaryOrganizationRole("member,admin")).toBe("admin");
      expect(resolvePrimaryOrganizationRole("member,owner")).toBe("owner");
    });

    it("accepts role arrays from Better Auth activeMember.role", () => {
      expect(resolvePrimaryOrganizationRole(["member"])).toBe("member");
      expect(resolvePrimaryOrganizationRole(["member", "admin"])).toBe("admin");
      expect(resolvePrimaryOrganizationRole(["owner", "member"])).toBe("owner");
    });

    it("returns null for unknown or empty roles", () => {
      expect(resolvePrimaryOrganizationRole("user")).toBeNull();
      expect(resolvePrimaryOrganizationRole("super-admin")).toBeNull();
      expect(resolvePrimaryOrganizationRole("")).toBeNull();
      expect(resolvePrimaryOrganizationRole(null)).toBeNull();
      expect(resolvePrimaryOrganizationRole(undefined)).toBeNull();
    });
  });
});
