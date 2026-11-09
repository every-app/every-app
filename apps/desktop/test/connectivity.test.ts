import { describe, expect, it } from "vitest";
import { ApiError } from "../src/main/api/client";
import { Connectivity, reachabilityOf } from "../src/main/connectivity";

/** Manual timers: run() fires the pending one. */
function harness(probeResults: unknown[] = []) {
  const timers: { fn: () => void; ms: number; id: number }[] = [];
  let next = 0;
  const probes: number[] = [];
  let signedIn = true;
  const c = new Connectivity({
    probe: async () => {
      probes.push(Date.now());
      return probeResults.length ? probeResults.shift() : undefined;
    },
    signedIn: () => signedIn,
    initialBackoffMs: 2000,
    maxBackoffMs: 16_000,
    setTimer: (fn, ms) => {
      const id = ++next;
      timers.push({ fn, ms, id });
      return id;
    },
    clearTimer: (id) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  const states: string[] = [];
  c.on("change", (s) => states.push(s));
  const fire = async () => {
    const t = timers.shift();
    if (!t) throw new Error("no timer");
    t.fn();
    await new Promise((r) => setTimeout(r, 0));
    return t.ms;
  };
  return { c, timers, probes, states, fire, setSignedIn: (v: boolean) => (signedIn = v) };
}

const network = new ApiError("network", "Couldn't reach Scribe: ECONNREFUSED");

describe("reachability of an outcome", () => {
  it("tells network trouble from answers", () => {
    expect(reachabilityOf(undefined)).toBe("reachable");
    expect(reachabilityOf(network)).toBe("unreachable");
    expect(reachabilityOf(new ApiError("server", "bad gateway", 502))).toBe("unreachable");
    expect(reachabilityOf(new ApiError("server", "unavailable", 503))).toBe("unreachable");
    expect(reachabilityOf(new ApiError("server", "not found", 404))).toBe("reachable");
    expect(reachabilityOf(new ApiError("server", "oops", 500))).toBe("reachable");
    expect(reachabilityOf(new ApiError("decoding", "junk"))).toBe("reachable");
    expect(reachabilityOf(ApiError.signedOut())).toBe("unknown");
    expect(reachabilityOf(ApiError.accessLogin())).toBe("unknown");
    expect(reachabilityOf(new TypeError("fetch failed"))).toBe("unreachable");
    expect(reachabilityOf(new Error("something else"))).toBe("unknown");
  });
});

describe("connectivity state machine", () => {
  it("goes offline on a network failure, probes with backoff, and comes back", async () => {
    const h = harness([network, network, undefined]);
    expect(h.c.state).toBe("online");
    h.c.report(network);
    expect(h.c.state).toBe("offline");
    expect(await h.fire()).toBe(2000); // probe 1: still down
    expect(h.c.state).toBe("offline");
    expect(await h.fire()).toBe(4000); // probe 2: still down
    expect(await h.fire()).toBe(8000); // probe 3: up
    expect(h.c.state).toBe("online");
    expect(h.timers).toHaveLength(0);
    expect(h.probes).toHaveLength(3);
    expect(h.states).toEqual(["offline", "online"]);
  });

  it("caps the backoff and resets it after recovery", async () => {
    const h = harness([network, network, network, network, network]);
    h.c.report(network);
    const delays = [];
    for (let i = 0; i < 5; i++) delays.push(await h.fire());
    expect(delays).toEqual([2000, 4000, 8000, 16_000, 16_000]);
    h.c.report(undefined); // any successful call
    expect(h.c.state).toBe("online");
    h.c.report(network);
    expect(h.timers[0]!.ms).toBe(2000);
  });

  it("any successful API call ends offline at once, and answers that aren't network don't count", () => {
    const h = harness();
    h.c.report(new ApiError("server", "not found", 404));
    expect(h.c.state).toBe("online");
    h.c.report(network);
    h.c.report(new ApiError("server", "boom", 500));
    expect(h.c.state).toBe("online");
    expect(h.timers).toHaveLength(0);
  });

  it("follows the OS network state, and probes at once when it comes back", async () => {
    const h = harness([undefined]);
    h.c.setOsOnline(false);
    expect(h.c.state).toBe("offline");
    h.c.setOsOnline(true);
    expect(h.c.state).toBe("online"); // nothing failed meanwhile
    h.c.report(network);
    h.c.setOsOnline(false);
    h.c.setOsOnline(true);
    expect(h.timers.at(-1)!.ms).toBe(0);
    await h.fire();
    expect(h.c.state).toBe("online");
  });

  it("probes at once on wake when it thought it was offline", async () => {
    const h = harness([undefined]);
    h.c.resumed();
    expect(h.timers).toHaveLength(0); // online: nothing to check
    h.c.report(network);
    h.c.resumed();
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0]!.ms).toBe(0);
    await h.fire();
    expect(h.c.state).toBe("online");
  });

  it("signin-needed overrides online and offline, and reset forgets everything", () => {
    const h = harness();
    h.c.setSignInNeeded(true);
    expect(h.c.state).toBe("signin-needed");
    h.c.report(network);
    expect(h.c.state).toBe("signin-needed");
    h.c.setSignInNeeded(false);
    expect(h.c.state).toBe("offline");
    h.c.reset();
    expect(h.c.state).toBe("online");
    expect(h.timers).toHaveLength(0);
    expect(h.states).toEqual(["signin-needed", "offline", "online"]);
  });

  it("doesn't probe while signed out", async () => {
    const h = harness();
    h.setSignedIn(false);
    h.c.report(network);
    await h.fire();
    expect(h.probes).toHaveLength(0);
  });
});
