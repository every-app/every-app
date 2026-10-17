/**
 * Every test file runs with its own empty HOME, so no test reads or writes
 * the real `~/.everyapp` (the private directories cf runs in), and no test
 * leaves signal handlers behind for the next. No
 * test reaches the network either: fetch, and undici's fetch the HTTPS
 * probes use, answer only local addresses unless a test stubs them (the
 * DNS-over-HTTPS lookups and certificate waits of a deploy take seams
 * instead).
 */
import fs from "node:fs";
import { afterAll, afterEach, vi } from "vitest";
import { resetInterruptsForTests } from "@/lib/interrupt";
import { makeTestHome } from "./home";

const home = makeTestHome();
process.env["HOME"] = home;
afterEach(() => resetInterruptsForTests());
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new TypeError(`fetch failed: tests don't reach the network (${url.origin})`);
  }
  return realFetch(input, init);
}) as typeof fetch;

vi.mock("undici", async (importOriginal) => {
  const undici = await importOriginal<typeof import("undici")>();
  const local = new Set(["localhost", "127.0.0.1", "[::1]"]);
  const guarded: typeof undici.fetch = async (input, init) => {
    const url = new URL(input instanceof undici.Request ? input.url : String(input));
    if (!local.has(url.hostname)) {
      throw new TypeError(`fetch failed: tests don't reach the network (${url.origin})`);
    }
    return undici.fetch(input, init);
  };
  return { ...undici, fetch: guarded };
});
