import { it as base, type TestAPI } from "vitest";
import { withOrganization } from "../src/server/context";

/** The organization the tests' background work belongs to. */
export const TEST_ORGANIZATION = "org_1";

/**
 * `it`, with each test run as `org_1`'s background work: the helpers under
 * test take whom a call is for from the request context, which these
 * files don't test (context.test.ts does), so each test gets one.
 */
export const it: TestAPI = Object.assign(
  ((name: string, fn: (...args: never[]) => unknown, timeout?: number) =>
    base(
      name,
      (...args: never[]) =>
        withOrganization(TEST_ORGANIZATION, () => fn(...args)),
      timeout,
    )) as unknown as TestAPI,
  base,
);
