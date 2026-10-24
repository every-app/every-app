/**
 * Forgetting the cache on an organization switch and on sign-out: plain
 * queries go, the collections' queries are reset so the collections keep
 * watching them, and the sign-in state survives a switch.
 */
import { QueryClient } from "@tanstack/query-core";
import { describe, expect, it } from "vitest";
import { forgetEverything, forgetEverythingButAuth } from "./forget";

function seededClient() {
  const queryClient = new QueryClient();
  queryClient.setQueryData(["auth", "session"], { user: { id: "u1" } });
  queryClient.setQueryData(["auth", "sign-in-methods"], { signUp: "open" });
  queryClient.setQueryData(["admin", "usage", "2026-10"], { byApp: [] });
  queryClient.setQueryData(["active-organization"], { id: "org-acme" });
  queryClient.setQueryData(["user-apps"], [{ id: "app-1" }]);
  queryClient.setQueryData(["admin", "users"], [{ id: "u1" }]);
  return queryClient;
}

describe("forgetEverythingButAuth", () => {
  it("removes the organization's answers and keeps the sign-in state", () => {
    const queryClient = seededClient();
    forgetEverythingButAuth(queryClient);

    expect(queryClient.getQueryData(["auth", "session"])).toEqual({
      user: { id: "u1" },
    });
    expect(queryClient.getQueryData(["auth", "sign-in-methods"])).toEqual({
      signUp: "open",
    });
    expect(queryClient.getQueryState(["admin", "usage", "2026-10"])).toBe(
      undefined,
    );
    expect(queryClient.getQueryState(["active-organization"])).toBe(undefined);
  });

  it("resets a collection's query instead of removing it", () => {
    const queryClient = seededClient();
    forgetEverythingButAuth(queryClient);

    for (const queryKey of [["user-apps"], ["admin", "users"]]) {
      const state = queryClient.getQueryState(queryKey);
      expect(state?.status).toBe("pending");
      expect(state?.data).toBe(undefined);
    }
  });
});

describe("forgetEverything", () => {
  it("forgets the sign-in state too", () => {
    const queryClient = seededClient();
    forgetEverything(queryClient);

    expect(queryClient.getQueryState(["auth", "session"])).toBe(undefined);
    expect(queryClient.getQueryState(["auth", "sign-in-methods"])).toBe(
      undefined,
    );
    expect(queryClient.getQueryState(["active-organization"])).toBe(undefined);
    expect(queryClient.getQueryState(["user-apps"])?.status).toBe("pending");
  });
});
