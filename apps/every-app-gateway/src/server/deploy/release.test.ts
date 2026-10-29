import { gzip, packRelease, releaseFiles, tar } from "@/test/app-release";
import { BUILD_SENTINEL } from "@every-app/sdk/cloudflare/sentinel";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseDeployUpload } from "./bundle";
import { DeployError } from "./errors";
import { bundleFromRelease, fetchAppRelease, parseRepoUrl } from "./release";
import { readTar, TarError } from "./tar";

const MANIFEST = { id: "todo", name: "Todos", resources: { d1: ["DB"] } };
const WORKER = {
  name: BUILD_SENTINEL.workerName,
  compatibilityDate: "2026-10-01",
  manifest: { type: "partial", mainModule: "index.js", modules: {} },
};
const LONG_ASSET = `assets/${"nested/".repeat(16)}logo.svg`;

function files(overrides: Partial<Parameters<typeof releaseFiles>[0]> = {}) {
  return releaseFiles({
    manifest: MANIFEST,
    worker: WORKER,
    modules: {
      "index.js": "export default {}",
      "index.js.map": "{}",
      ".vite/manifest.json": "{}",
    },
    assets: {
      "favicon.ico": new Uint8Array([1, 2, 3]),
      [LONG_ASSET]: "<svg/>",
    },
    migrations: {
      "0001_more/migration.sql": "CREATE TABLE more (id text);",
      "0000_init.sql": "CREATE TABLE todos (id text);",
      "meta/_journal.json": "{}",
    },
    ...overrides,
  });
}

const unpack = (archive: Uint8Array) => readTar(archive, { maxFiles: 100 });

async function refusal(promise: Promise<unknown>): Promise<DeployError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DeployError);
  return error as DeployError;
}

const repo = parseRepoUrl("https://github.com/acme/todo");

/** GitHub's answers for the release download, by URL. */
function stubGitHub(tarball: Uint8Array | null, headers: HeadersInit = {}) {
  const seen: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    if (url.endsWith("/releases/latest/download/everyapp-release.tar.gz")) {
      return tarball
        ? new Response(null, {
            status: 302,
            headers: {
              location:
                "https://github.com/acme/todo/releases/download/v1.2.3/everyapp-release.tar.gz",
            },
          })
        : new Response("Not Found", { status: 404 });
    }
    if (url.includes("/releases/download/v1.2.3/")) {
      return new Response(null, {
        status: 302,
        headers: {
          location:
            "https://release-assets.githubusercontent.com/github-production-release-asset/1?sig=x",
        },
      });
    }
    return new Response(tarball as Uint8Array<ArrayBuffer>, { headers });
  });
  return seen;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readTar", () => {
  it("reads files, pax long names and directories", () => {
    const archive = tar([
      { path: "./" },
      { path: "./a/" },
      { path: "./a/b.txt", data: "hi" },
      { path: `./a/${"x".repeat(120)}.txt`, data: "long" },
    ]);
    const read = unpack(archive);
    expect([...read.keys()]).toEqual(["a/b.txt", `a/${"x".repeat(120)}.txt`]);
    expect(new TextDecoder().decode(read.get("a/b.txt"))).toBe("hi");
  });

  it.each([
    ["a path outside the archive", { path: "../evil", data: "x" }],
    ["a path inside that climbs out", { path: "a/../../evil", data: "x" }],
    ["an absolute path", { path: "/etc/passwd", data: "x" }],
    ["a symlink", { path: "link", type: "2", linkname: "/etc/passwd" }],
    ["a hard link", { path: "link", type: "1", linkname: "release.json" }],
    ["a device", { path: "dev", type: "3" }],
  ])("refuses %s", (_, entry) => {
    expect(() => unpack(tar([entry]))).toThrow(TarError);
  });

  it("refuses a file listed twice and a corrupt header", () => {
    expect(() =>
      unpack(
        tar([
          { path: "a", data: "1" },
          { path: "./a", data: "2" },
        ]),
      ),
    ).toThrow(/twice/);
    const corrupt = tar([{ path: "a", data: "1" }]);
    corrupt[0] = "b".charCodeAt(0);
    expect(() => unpack(corrupt)).toThrow(/checksum/);
  });
});

describe("bundleFromRelease", () => {
  it("makes the DeployBundle a multipart upload of the same Build Output makes", async () => {
    const { release, bundle } = await bundleFromRelease(files());
    expect(release).toMatchObject({ appId: "todo", version: "1.2.3" });
    expect(bundle.manifest).toEqual(MANIFEST);
    expect(bundle.stamp).toEqual({
      protocol: 1,
      sdkVersion: "0.3.0",
      cliVersion: "0.3.0",
    });
    expect(bundle.worker).toEqual(WORKER);
    // Modules only, as the CLI filters them: not the Vite manifest.
    expect([...bundle.modules.keys()]).toEqual(["index.js", "index.js.map"]);
    expect([...bundle.assets.keys()].sort()).toEqual(
      [`/${LONG_ASSET}`, "/favicon.ico"].sort(),
    );
    expect(bundle.migrations.map((m) => m.name)).toEqual([
      "0000_init.sql",
      "0001_more/migration.sql",
    ]);

    // The same files, as `everyapp deploy --gateway` uploads them.
    const form = new FormData();
    form.set("manifest", JSON.stringify(MANIFEST));
    form.set(
      "stamp",
      JSON.stringify({ protocol: 1, sdkVersion: "0.3.0", cliVersion: "0.3.0" }),
    );
    form.set("worker", JSON.stringify(WORKER));
    form.set("module:index.js", new File(["export default {}"], "index.js"));
    form.set("module:index.js.map", new File(["{}"], "index.js.map"));
    form.set("asset:/favicon.ico", new File([new Uint8Array([1, 2, 3])], "f"));
    form.set(`asset:/${LONG_ASSET}`, new File(["<svg/>"], "logo.svg"));
    form.set(
      "migration:0000_init.sql",
      new File(["CREATE TABLE todos (id text);"], "0000_init.sql"),
    );
    form.set(
      "migration:0001_more/migration.sql",
      new File(["CREATE TABLE more (id text);"], "migration.sql"),
    );
    const uploaded = await parseDeployUpload(
      new Request("https://gateway.example.com/", {
        method: "POST",
        body: form,
      }),
    );
    expect(bundle).toEqual(uploaded);
  });

  it("refuses a release whose files don't match its sha256", async () => {
    const tampered = files();
    tampered.set(
      ".cloudflare/output/v0/workers/default/bundle/index.js",
      new TextEncoder().encode("export default { fetch() { steal() } }"),
    );
    const error = await refusal(bundleFromRelease(tampered));
    expect(error.code).toBe("RELEASE_CORRUPT");
  });

  it("refuses a release with helper Workers, extra entries or another kind", async () => {
    const helper = await refusal(
      bundleFromRelease(
        files({
          extra: {
            ".cloudflare/output/v0/workers/helper/worker.config.json": "{}",
          },
        }),
      ),
    );
    expect(helper.code).toBe("BUNDLE_REFUSED");
    expect(helper.message).toContain("helper");

    const extra = await refusal(
      bundleFromRelease(files({ extra: { "cloudflare.config.ts": "evil()" } })),
    );
    expect(extra.code).toBe("RELEASE_INVALID");

    const gateway = await refusal(
      bundleFromRelease(files({ release: { kind: "gateway" } })),
    );
    expect(gateway.code).toBe("RELEASE_UNSUPPORTED");
    const v1 = await refusal(
      bundleFromRelease(files({ release: { buildOutputVersion: "v1" } })),
    );
    expect(v1.code).toBe("RELEASE_UNSUPPORTED");
  });
});

describe("fetchAppRelease", () => {
  it("binds approval to release metadata as well as the built files", async () => {
    const original = files();
    stubGitHub(packRelease(original));
    const before = await fetchAppRelease(repo);
    const changed = new Map(original);
    const metadata = JSON.parse(
      new TextDecoder().decode(changed.get("release.json")),
    );
    metadata.manifest.name = "Changed app";
    changed.set(
      "release.json",
      new TextEncoder().encode(JSON.stringify(metadata)),
    );
    stubGitHub(packRelease(changed));
    const after = await fetchAppRelease(repo);
    expect(before.sha256).not.toBe(after.sha256);
  });
  it("downloads the latest release, following GitHub's redirects to its tag", async () => {
    const seen = stubGitHub(packRelease(files()));
    const release = await fetchAppRelease(repo);
    expect(release.appId).toBe("todo");
    expect(release.source).toEqual({
      repoUrl: "https://github.com/acme/todo",
      tag: "v1.2.3",
      version: "1.2.3",
      gitSha: "0123456789abcdef0123456789abcdef01234567",
    });
    expect(seen).toHaveLength(3);
  });

  it("answers NO_RELEASE when the repository publishes none", async () => {
    stubGitHub(null);
    const error = await refusal(fetchAppRelease(repo));
    expect(error.code).toBe("NO_RELEASE");
    expect(error.message).toContain("pnpm everyapp deploy");
  });

  it("refuses an oversize release, by its length or once unpacked", async () => {
    stubGitHub(packRelease(files()), {
      "content-length": String(200 * 1024 * 1024),
    });
    expect((await refusal(fetchAppRelease(repo))).code).toBe(
      "RELEASE_TOO_LARGE",
    );
    // A gzip bomb: small on the wire, over the cap unpacked.
    stubGitHub(gzip(new Uint8Array(101 * 1024 * 1024)));
    expect((await refusal(fetchAppRelease(repo))).code).toBe(
      "RELEASE_TOO_LARGE",
    );
  });

  it("refuses an archive with a path outside it, or that isn't gzip", async () => {
    stubGitHub(gzip(tar([{ path: "../release.json", data: "{}" }])));
    const outside = await refusal(fetchAppRelease(repo));
    expect(outside.code).toBe("RELEASE_INVALID");
    expect(outside.message).toContain("../release.json");

    stubGitHub(new TextEncoder().encode("not gzip"));
    expect((await refusal(fetchAppRelease(repo))).code).toBe("RELEASE_INVALID");
  });
});

describe("parseRepoUrl", () => {
  it.each([
    ["https://github.com/acme/todo", "https://github.com/acme/todo"],
    ["https://github.com/acme/todo/", "https://github.com/acme/todo"],
    ["https://github.com/acme/todo.git", "https://github.com/acme/todo"],
    ["  https://github.com/a-b/my.app  ", "https://github.com/a-b/my.app"],
  ])("takes %s", (raw, repoUrl) => {
    expect(parseRepoUrl(raw).repoUrl).toBe(repoUrl);
  });

  it.each([
    "http://github.com/acme/todo",
    "https://gitlab.com/acme/todo",
    "https://github.com/acme",
    "https://github.com/acme/todo/tree/main",
    "https://github.com/acme/..",
    "https://github.com.evil.com/acme/todo",
    "https://user@github.com/acme/todo",
    42,
  ])("refuses %s", (raw) => {
    expect(() => parseRepoUrl(raw)).toThrow(
      expect.objectContaining({ code: "INVALID_REPO_URL" }),
    );
  });
});
