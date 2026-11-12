import generated from "@/lib/openscribe-data.generated.json";

// What scripts/sync-openscribe-data.js writes before dev, build and
// types:check: the committed openscribe-data.fallback.json, replaced by what
// GitHub answered.

export type RepoLanguage = { name: string; percent: number; color: string };

export type Repo = {
  owner: string;
  name: string;
  url: string;
  description: string;
  homepage: string | null;
  /** False until GitHub's API serves the repository: no counts to show. */
  public: boolean;
  stars: number | null;
  forks: number | null;
  watchers: number | null;
  issues: number | null;
  contributors: number | null;
  license: string | null;
  topics: string[];
  languages: RepoLanguage[];
};

type OpenScribeData = {
  repos: { everyApp: Repo; openScribe: Repo };
};

const data: OpenScribeData = generated;

export const EVERY_APP_REPO = data.repos.everyApp;
export const OPENSCRIBE_REPO = data.repos.openScribe;

// The newest DMG for each chip, redirected by the updates Worker
// (apps/desktop/updates/index.ts).
export const DOWNLOAD_URLS = {
  appleSilicon: "https://updates.everyapp.com/mac/download/arm64",
  intel: "https://updates.everyapp.com/mac/download/x64",
} as const;

// The share card scripts/generate-social-cards.js draws for /openscribe.
export const OPENSCRIBE_CARD_PATH = "/og/openscribe.png";
