#!/usr/bin/env node

const BASE_URL = (process.env.BASE_URL ?? "https://everyapp.dev").replace(
  /\/+$/,
  "",
);
const CANONICAL_BASE_URL = (
  process.env.CANONICAL_BASE_URL ?? "https://everyapp.dev"
).replace(/\/+$/, "");

const checks = [
  {
    type: "redirect",
    from: "/docs/quickstart",
    to: "/docs/getting-started/quickstart",
    expectedCodes: [301, 308],
  },
  {
    type: "redirect",
    from: "/docs/build-an-app",
    to: "/docs/build-an-app/create-app",
    expectedCodes: [301, 308],
  },
  {
    type: "redirect",
    from: "/docs/getting-started/quickstart/",
    to: "/docs/getting-started/quickstart",
    expectedCodes: [301, 307, 308],
  },
  {
    type: "status",
    path: "/docs/getting-started/quickstart",
    expectedCode: 200,
  },
  {
    type: "status",
    path: "/docs/build-an-app/create-app",
    expectedCode: 200,
  },
  {
    type: "status",
    path: "/blogs/welcome",
    expectedCode: 200,
  },
  { type: "status", path: "/robots.txt", expectedCode: 200 },
  { type: "status", path: "/sitemap.xml", expectedCode: 200 },
];

const seoPages = [
  "/docs/getting-started/quickstart",
  "/docs/build-an-app/create-app",
  "/docs/coding-agents",
  "/blogs/welcome",
];

function toUrl(path) {
  return new URL(path, `${BASE_URL}/`).toString();
}

function toCanonicalUrl(path) {
  return new URL(path, `${CANONICAL_BASE_URL}/`).toString();
}

function normalizePathLike(value) {
  const url = new URL(value, `${BASE_URL}/`);
  return url.pathname.replace(/\/+$/, "") || "/";
}

async function checkStatus(path, expectedCode) {
  const response = await fetch(toUrl(path), { redirect: "manual" });
  const passed = response.status === expectedCode;
  const message = `status ${path} -> ${response.status}, expected ${expectedCode}`;
  return { passed, message };
}

async function checkRedirect(from, to, expectedCodes) {
  const response = await fetch(toUrl(from), { redirect: "manual" });
  const location = response.headers.get("location") ?? "";
  const actualPath = normalizePathLike(location || from);
  const expectedPath = normalizePathLike(to);

  const codeOk = expectedCodes.includes(response.status);
  const pathOk = actualPath === expectedPath;
  const passed = codeOk && pathOk;
  const message = `redirect ${from} -> ${location || "(none)"} [${response.status}], expected ${to} [${expectedCodes.join("/")}]`;

  return { passed, message };
}

function extractMeta(html, pattern) {
  return (html.match(pattern) ?? [])[1] ?? "";
}

async function checkPageSeo(path) {
  const response = await fetch(toUrl(path), { redirect: "follow" });
  const html = await response.text();

  const title = extractMeta(html, /<title>([^<]+)<\/title>/i);
  const canonical = extractMeta(
    html,
    /<link[^>]+rel="canonical"[^>]+href="([^"]+)"/i,
  );
  const description = extractMeta(
    html,
    /<meta[^>]+name="description"[^>]+content="([^"]*)"/i,
  );

  const expectedCanonical = toCanonicalUrl(path);

  return {
    path,
    title,
    description,
    canonical,
    canonicalPassed: canonical === expectedCanonical,
  };
}

async function checkSitemap() {
  const response = await fetch(toUrl("/sitemap.xml"));
  const xml = await response.text();

  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const hasTrailingSlash = urls.some((url) => {
    const path = new URL(url).pathname;
    return path !== "/" && path.endsWith("/");
  });

  let all200 = true;
  const canVerifyStatuses =
    new URL(BASE_URL).origin === new URL(CANONICAL_BASE_URL).origin;

  if (canVerifyStatuses) {
    for (const url of urls) {
      const res = await fetch(url, { redirect: "manual" });
      if (res.status !== 200) {
        all200 = false;
        break;
      }
    }
  }

  return {
    hasTrailingSlash,
    all200,
    canVerifyStatuses,
    count: urls.length,
  };
}

async function run() {
  let failures = 0;

  console.log(`Verifying SEO for ${BASE_URL}`);

  for (const check of checks) {
    const result =
      check.type === "status"
        ? await checkStatus(check.path, check.expectedCode)
        : await checkRedirect(check.from, check.to, check.expectedCodes);

    console.log(`${result.passed ? "PASS" : "FAIL"} ${result.message}`);
    if (!result.passed) failures += 1;
  }

  const seoResults = [];
  for (const path of seoPages) {
    seoResults.push(await checkPageSeo(path));
  }

  const uniqueTitles = new Set(seoResults.map((r) => r.title)).size;

  for (const result of seoResults) {
    const ok = result.canonicalPassed;
    console.log(
      `${ok ? "PASS" : "FAIL"} canonical ${result.path} -> ${result.canonical}`,
    );
    if (!ok) failures += 1;
  }

  const titlesPassed = uniqueTitles === seoResults.length;
  console.log(
    `${titlesPassed ? "PASS" : "FAIL"} unique titles ${uniqueTitles}/${seoResults.length}`,
  );
  if (!titlesPassed) failures += 1;

  const sitemap = await checkSitemap();
  console.log(
    `${!sitemap.hasTrailingSlash ? "PASS" : "FAIL"} sitemap has no trailing-slash URLs`,
  );
  if (sitemap.canVerifyStatuses) {
    console.log(`${sitemap.all200 ? "PASS" : "FAIL"} sitemap URLs return 200`);
  } else {
    console.log(
      "INFO skipped sitemap URL status checks (BASE_URL and CANONICAL_BASE_URL differ)",
    );
  }
  console.log(`INFO sitemap URL count: ${sitemap.count}`);

  if (sitemap.hasTrailingSlash) failures += 1;
  if (sitemap.canVerifyStatuses && !sitemap.all200) failures += 1;

  if (failures > 0) {
    console.log(`\nResult: FAIL (${failures} checks failed)`);
    process.exit(1);
  }

  console.log("\nResult: PASS");
}

run().catch((error) => {
  console.error("ERROR", error);
  process.exit(1);
});
