import { expect, it } from "vitest";
import * as server from "./index";

// @ts-expect-error protocol constants are internal-only; app authors import helpers from /server.
import type { IDENTITY_HEADER } from "./index";
// @ts-expect-error the tools contract is internal-only too.
import type { TOOLS_CALL_PATH } from "./index";

type InternalConstantMustNotBePublic = typeof IDENTITY_HEADER;
void (undefined as unknown as InternalConstantMustNotBePublic);
type ToolsContractMustNotBePublic = typeof TOOLS_CALL_PATH;
void (undefined as unknown as ToolsContractMustNotBePublic);

it("keeps protocol constants out of /server", () => {
  expect(server).not.toHaveProperty("IDENTITY_HEADER");
  expect(server).not.toHaveProperty("SYSTEM_HEADER");
  expect(server).not.toHaveProperty("TOOLS_CALL_PATH");
  expect(server).not.toHaveProperty("mintSystemJwt");
});

it("leaves out what no app imports", () => {
  for (const name of [
    "gatewayEmailBinding",
    "fromMcpTools",
    "withOrganization",
    "currentUser",
    "requireCurrentUser",
    "IdentityError",
    "RequestContextError",
    "OrganizationMismatchError",
  ]) {
    expect(server).not.toHaveProperty(name);
  }
});

it("has no second way to call a model", () => {
  expect(typeof server.createGatewayFetch).toBe("function");
  for (const gone of [
    "ai",
    "aiStatus",
    "AI_DEFAULT_BASE_URL",
    "gatewayAiBinding",
    "isAiNotConfigured",
    "AI_NOT_CONFIGURED_CODES",
  ]) {
    expect(server).not.toHaveProperty(gone);
  }
});

it("exposes the agent tools API and not the old MCP handler", () => {
  expect(typeof server.defineTools).toBe("function");
  expect(new server.ToolError("x")).toBeInstanceOf(Error);
  // Apps define tools and the gateway speaks MCP; createMcpHandler
  // (deprecated in 0.3.0) is gone.
  expect(server).not.toHaveProperty("createMcpHandler");
});
