#!/usr/bin/env node

// Writes src/lib/openscribe-data.generated.json, which the /openscribe page
// and its share card (scripts/generate-social-cards.js) read: the two GitHub
// repositories' counts, topics and languages. Everything starts from the
// committed src/lib/openscribe-data.fallback.json and is replaced by what
// GitHub answers, so a build with no network, a rate-limited one, or one
// that runs before a repository is public still succeeds with the fallback.
// The repository URLs live in the fallback file and nowhere else.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FALLBACK_FILE = join(
  __dirname,
  "../src/lib/openscribe-data.fallback.json",
);
const OUT_FILE = join(__dirname, "../src/lib/openscribe-data.generated.json");
const TIMEOUT_MS = 5000;

// GitHub's own language colours (github-linguist).
const LANGUAGE_COLORS = {
  TypeScript: "#3178c6",
  JavaScript: "#f1e05a",
  Swift: "#f05138",
  MDX: "#fcb32c",
  CSS: "#663399",
  Shell: "#89e051",
  HTML: "#e34c26",
};
const OTHER_COLOR = "#8b949e";

async function get(url, headers = {}) {
  const response = await fetch(url, {
    headers: { "user-agent": "everyapp-landing-page-build", ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response;
}

function github(path) {
  const token = process.env.GITHUB_TOKEN;
  return get(`https://api.github.com${path}`, {
    accept: "application/vnd.github+json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  });
}

// One contributor per page, so the last page's number is the count.
async function contributorCount(fullName) {
  const response = await github(`/repos/${fullName}/contributors?per_page=1`);
  const last = response.headers
    .get("link")
    ?.match(/[?&]page=(\d+)>; rel="last"/);
  if (last) return Number(last[1]);
  return (await response.json()).length;
}

async function languages(fullName) {
  const bytes = await (await github(`/repos/${fullName}/languages`)).json();
  const total = Object.values(bytes).reduce((sum, n) => sum + n, 0);
  if (total === 0) return null;
  return Object.entries(bytes)
    .map(([name, n]) => ({
      name,
      percent: Math.round((n / total) * 1000) / 10,
    }))
    .filter((language) => language.percent >= 0.1);
}

async function repository(fallback) {
  const fullName = `${fallback.owner}/${fallback.name}`;
  try {
    const repo = await (await github(`/repos/${fullName}`)).json();
    // A private repository a token can see is still not one to link to.
    if (repo.private) return fallback;
    const [contributors, langs] = await Promise.all([
      contributorCount(fullName).catch(() => fallback.contributors),
      languages(fullName).catch(() => null),
    ]);
    return {
      ...fallback,
      description: repo.description || fallback.description,
      homepage: repo.homepage || fallback.homepage,
      public: true,
      stars: repo.stargazers_count,
      forks: repo.forks_count,
      watchers: repo.subscribers_count,
      issues: repo.open_issues_count,
      contributors,
      license: repo.license?.spdx_id ?? fallback.license,
      topics: repo.topics ?? fallback.topics,
      languages: langs ?? fallback.languages,
    };
  } catch (error) {
    console.warn(
      `${fullName}: using the committed fallback (${error.message})`,
    );
    return fallback;
  }
}

function withColors(repo) {
  return {
    ...repo,
    languages: repo.languages.map((language) => ({
      ...language,
      color: LANGUAGE_COLORS[language.name] ?? OTHER_COLOR,
    })),
  };
}

const fallback = JSON.parse(readFileSync(FALLBACK_FILE, "utf8"));
const [everyApp, openScribe] = await Promise.all([
  repository(fallback.repos.everyApp),
  repository(fallback.repos.openScribe),
]);

writeFileSync(
  OUT_FILE,
  `${JSON.stringify(
    {
      repos: {
        everyApp: withColors(everyApp),
        openScribe: withColors(openScribe),
      },
    },
    null,
    2,
  )}\n`,
);
