import { expect, it } from "vitest";

// @ts-expect-error protocol constants are internal-only; app authors import helpers from /server.
import type { IDENTITY_HEADER } from "./index";

type InternalConstantMustNotBePublic = typeof IDENTITY_HEADER;
void (undefined as unknown as InternalConstantMustNotBePublic);

it("keeps protocol constants out of /server", () => {
  expect(true).toBe(true);
});
