/**
 * The four apps the empty home offers, and where each comes from. The one
 * place a repository URL or a card line changes: the README's "Four apps on
 * day one" links the same repositories (featuredApps.test.ts holds the two
 * to the same URLs) and prints the same lines (by hand, for now).
 */

/** The GitHub owner the four repositories are published under. */
export const FEATURED_APPS_OWNER = "https://github.com/every-app";

type FeaturedAppId = "openseo" | "crm" | "analytics" | "openmail";

export interface FeaturedApp {
  /** The manifest id: the app's hostname label and its icon file's name. */
  id: FeaturedAppId;
  name: string;
  /** One line, the one the README and the docs home print. */
  line: string;
  /** The repository `everyapp install` takes (its latest release). */
  repo: string;
  /**
   * What to have ready, as a person reads it: R2 on the account when the
   * app binds a bucket (the install stops without it), then the manifest's
   * required providers, capabilities and secrets, leaving out a secret the
   * deploy generates. Empty when the app opens with nothing set. After the
   * install, the app's setup dialog names each key and the one command that
   * sets it. Checked against each app's everyapp.config.ts and
   * cloudflare.config.ts on 2026-11-12.
   */
  needs: readonly string[];
}

export const FEATURED_APPS: readonly FeaturedApp[] = [
  {
    id: "openseo",
    name: "OpenSEO",
    line: "Keyword research, rank tracking and site audits.",
    repo: `${FEATURED_APPS_OWNER}/open-seo`,
    needs: [
      "R2 turned on in your Cloudflare account",
      "An OpenRouter key",
      "A DataForSEO key",
    ],
  },
  {
    id: "crm",
    name: "OpenCRM",
    line: "A simple CRM.",
    repo: `${FEATURED_APPS_OWNER}/open-crm`,
    needs: ["R2 turned on in your Cloudflare account"],
  },
  {
    id: "analytics",
    name: "OpenAnalytics",
    line: "Web analytics without cookies.",
    repo: `${FEATURED_APPS_OWNER}/open-analytics`,
    needs: [],
  },
  {
    id: "openmail",
    name: "OpenMail",
    line: "An email inbox with an AI assistant.",
    repo: `${FEATURED_APPS_OWNER}/open-mail`,
    needs: [
      "R2 turned on in your Cloudflare account",
      "A key for an AI model, such as OpenRouter",
      "A mail domain on Cloudflare",
    ],
  },
];

/** The launcher icon each app ships, copied to public/apps/ (Streamline Plump Color, CC BY 4.0). */
export function featuredAppIcon(app: Pick<FeaturedApp, "id">): string {
  return `/apps/${app.id}.svg`;
}

/** The one command that installs the app on this Gateway, from the every-app folder. */
export function featuredInstallCommand(app: Pick<FeaturedApp, "repo">): string {
  return `pnpm everyapp install ${app.repo}`;
}
