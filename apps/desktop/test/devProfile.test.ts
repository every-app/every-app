import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRESH_PREFIX, freshProfileDir, removeFreshProfile } from "../src/main/devProfile";

const base = () => mkdtempSync(join(tmpdir(), "everyapp-fresh-base-"));

describe("fresh dev profile (EVERYAPP_DESKTOP_DEV_FRESH)", () => {
  it("is only made in a dev build that asks for it", () => {
    const b = base();
    expect(freshProfileDir({}, true, b)).toBeUndefined();
    expect(freshProfileDir({ EVERYAPP_DESKTOP_DEV_FRESH: "1" }, false, b)).toBeUndefined(); // never in a release
    expect(freshProfileDir({ EVERYAPP_DESKTOP_DEV_FRESH: "true" }, true, b)).toBeUndefined();
    const dir = freshProfileDir({ EVERYAPP_DESKTOP_DEV_FRESH: "1" }, true, b)!;
    expect(dir.startsWith(join(b, FRESH_PREFIX))).toBe(true);
    expect(existsSync(dir)).toBe(true);
  });

  it("is a new, empty dir every launch, and is removed on quit", () => {
    const b = base();
    const one = freshProfileDir({ EVERYAPP_DESKTOP_DEV_FRESH: "1" }, true, b)!;
    writeFileSync(join(one, "settings.json"), "{}");
    const two = freshProfileDir({ EVERYAPP_DESKTOP_DEV_FRESH: "1" }, true, b)!;
    expect(two).not.toBe(one);
    expect(existsSync(join(two, "settings.json"))).toBe(false);
    removeFreshProfile(one);
    expect(existsSync(one)).toBe(false);
  });

  it("sweeps stale leftovers from a crashed run, and nothing else", () => {
    const b = base();
    const stale = join(b, `${FRESH_PREFIX}old`);
    const recent = join(b, `${FRESH_PREFIX}recent`);
    const other = join(b, "someone-else");
    for (const d of [stale, recent, other]) mkdirSync(d);
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    utimesSync(stale, old, old);
    utimesSync(other, old, old);
    freshProfileDir({ EVERYAPP_DESKTOP_DEV_FRESH: "1" }, true, b);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(other)).toBe(true);
  });

  it("refuses to delete anything that isn't a fresh profile", () => {
    const b = base();
    const real = join(b, "Every App Dev");
    mkdirSync(real);
    removeFreshProfile(real);
    removeFreshProfile(undefined);
    expect(existsSync(real)).toBe(true);
  });
});
