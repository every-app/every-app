/**
 * The four apps the empty home offers, and where each comes from. The one
 * place a repository URL or a card line changes: the README's "Four apps on
 * day one" links the same repositories (featuredApps.test.ts holds the two
 * to the same URLs) and prints the same lines (by hand, for now).
 */

/** The GitHub owner the four repositories are published under. */
export const FEATURED_APPS_OWNER = "https://github.com/every-app";

type FeaturedAppId = "openseo" | "crm" | "analytics" | "agentic-inbox";

export interface FeaturedApp {
  /** The manifest id: the app's hostname label and its icon file's name. */
  id: FeaturedAppId;
  name: string;
  /** One line, the one the README and the docs home print. */
  line: string;
  /** The repository `everyapp install` takes (its latest release). */
  repo: string;
  /**
   * What the Gateway or the app must hold before it opens, as a person
   * reads it: the manifest's required providers, capabilities and secrets.
   * After the install, the app's setup dialog names each key and the one
   * command that sets it; this only says what to have ready.
   */
  needs: readonly string[];
}

export const FEATURED_APPS: readonly FeaturedApp[] = [
  {
    id: "openseo",
    name: "OpenSEO",
    line: "SEO research, rank tracking, site audits and AI visibility for your sites.",
    repo: `${FEATURED_APPS_OWNER}/open-seo`,
    needs: ["An OpenRouter key", "A DataForSEO key"],
  },
  {
    id: "crm",
    name: "OpenCRM",
    line: "Companies, contacts and deals, kept up to date by a research agent.",
    repo: `${FEATURED_APPS_OWNER}/open-crm`,
    needs: ["An OpenRouter key", "A Context.dev key"],
  },
  {
    id: "analytics",
    name: "OpenAnalytics",
    line: "Web analytics for your sites. No cookies, no stored IP addresses.",
    repo: `${FEATURED_APPS_OWNER}/open-analytics`,
    needs: ["A secret of its own, at least 32 random characters"],
  },
  {
    id: "agentic-inbox",
    name: "Agentic Inbox",
    line: "A team inbox with an AI agent that reads, drafts and sends email on your domain.",
    repo: `${FEATURED_APPS_OWNER}/agentic-inbox`,
    needs: ["An OpenRouter key", "A mail domain on Cloudflare"],
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
