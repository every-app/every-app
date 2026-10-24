/**
 * The four apps the empty home offers: one entry each, with the icon the
 * gateway serves and the repository the README links, so the home, the
 * README and the docs home name the same apps at the same addresses.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FEATURED_APPS,
  FEATURED_APPS_OWNER,
  featuredAppIcon,
  featuredInstallCommand,
} from "./featuredApps";

const GATEWAY_DIR = path.resolve(__dirname, "../../..");
const README = readFileSync(
  path.resolve(GATEWAY_DIR, "../../README.md"),
  "utf8",
);

describe("the featured apps", () => {
  it("are the four, each once, OpenSEO first", () => {
    expect(FEATURED_APPS.map((app) => app.id)).toEqual([
      "openseo",
      "crm",
      "analytics",
      "agentic-inbox",
    ]);
    expect(FEATURED_APPS.map((app) => app.name)).toEqual([
      "OpenSEO",
      "OpenCRM",
      "OpenAnalytics",
      "Agentic Inbox",
    ]);
  });

  it.each(FEATURED_APPS)("$name ships its icon and a one-line card", (app) => {
    expect(
      existsSync(path.join(GATEWAY_DIR, "public", featuredAppIcon(app))),
    ).toBe(true);
    expect(app.line.length).toBeLessThanOrEqual(90);
    expect(app.line.endsWith(".")).toBe(true);
    expect(app.line).not.toContain("organization");
    expect(app.needs.length).toBeGreaterThan(0);
  });

  it.each(FEATURED_APPS)(
    "$name installs from the repository the README links",
    (app) => {
      expect(app.repo.startsWith(`${FEATURED_APPS_OWNER}/`)).toBe(true);
      expect(README).toContain(`(${app.repo})`);
      expect(featuredInstallCommand(app)).toBe(
        `pnpm everyapp install ${app.repo}`,
      );
    },
  );
});
