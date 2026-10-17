/**
 * Postiz as it ports to Every App (the ports plan, §4): the manifest of
 * `apps/frontend/everyapp.config.ts` as written, and its
 * `cloudflare.config.ts` + `vite-plugin-every-app.ts` as `cf build`
 * evaluates them in production. Two Workers: the app Worker (the vinext
 * frontend, which proxies `/api/*` to the helper over `API` and serves
 * `/uploads/*` from the bucket named after itself) and the helper `api`
 * (the NestJS backend on D1, which defines PublishPostWorkflow and runs the
 * reconcile cron every ten minutes).
 *
 * `migrations/0001_init.sql` beside this file is Prisma's 171-statement
 * init for the converted schema (43 tables, 18 unique and 110 other
 * indexes) with `--> statement-breakpoint` between statements: the copy
 * `scripts/prisma/to-d1-migration.mjs` writes, byte for byte the one the
 * prisma-d1 spike applied with `cf d1 migrations apply`.
 */
import { fileURLToPath } from "node:url";
import { bindings } from "@cloudflare/config";
import { everyAppAuxiliaryWorker, everyAppWorker } from "@every-app/sdk/cloudflare";
import type { EveryAppCliManifest } from "@/lib/manifest";
import type { FakeAppConfig } from "@/test/fakeCloudflare";

export const POSTIZ_MIGRATIONS_DIR = fileURLToPath(
  new URL("../postiz/migrations", import.meta.url),
);

/** `apps/frontend/everyapp.config.ts` (MVP; `capabilities` come with PR 3 and PR 4). */
export const postiz = {
  id: "postiz",
  name: "Postiz",
  description: "Schedule and publish social media posts from one calendar.",
  resources: {
    d1: ["DB"],
    workflows: [{ name: "PUBLISH_POST", className: "PublishPostWorkflow", worker: "api" }],
  },
  workers: [{ name: "api", binding: "API", limits: { cpuMs: 300_000 } }],
  database: { provider: "d1" },
  migrations: { engine: "d1-sql", dir: "migrations", binding: "DB" },
  providers: ["openai"],
  ai: { models: ["gpt-4.1", "gpt-4o-2024-08-06", "gpt-5.2", "chatgpt-image-latest"] },
  public: [],
  access: "everyone",
  install: "pnpm install --frozen-lockfile",
  build: "pnpm exec vite build",
  dev: "pnpm exec vite build --mode development && pnpm exec vite preview --host 127.0.0.1 --port $PORT",
} as const satisfies EveryAppCliManifest;

/** The app's own secrets: required JWT_SECRET, optional X, interim LinkedIn/Mastodon. */
const POSTIZ_SECRETS = [
  "JWT_SECRET",
  "X_API_KEY",
  "X_API_SECRET",
  "LINKEDIN_CLIENT_ID",
  "LINKEDIN_CLIENT_SECRET",
  "MASTODON_CLIENT_ID",
  "MASTODON_CLIENT_SECRET",
  "MASTODON_URL",
] as const;

export const POSTIZ_FEATURES = {
  ai: true,
  agents: false,
  analytics: false,
  autopost: false,
  plugs: false,
  thirdParty: false,
  webhooks: false,
  sets: false,
  publicApi: false,
  team: "readonly",
  preview: false,
  billing: false,
  email: false,
};

export const POSTIZ_CRON = "*/10 * * * *";

/**
 * What both Workers add to the SDK's definition: the SSRF guard flag, the
 * feature flags and, unless the manifest declares `resources.r2` (which
 * binds it on both already), the bucket named after the app's Worker by
 * hand (`bindings.r2({ name: appWorkerName })`).
 */
function withPostizRuntime<W extends { compatibilityFlags: string[]; env: object }>(
  worker: W,
  appWorkerName: string,
  handWrittenR2: boolean,
) {
  return {
    ...worker,
    compatibilityFlags: [...worker.compatibilityFlags, "global_fetch_strictly_public"],
    env: {
      ...worker.env,
      ...(handWrittenR2 ? { R2: bindings.r2({ name: appWorkerName }) } : {}),
      IS_GENERAL: bindings.text("true"),
      POSTIZ_FEATURES: bindings.json(POSTIZ_FEATURES),
      EVERYAPP_HEADER_AUTH: bindings.text("true"),
      AI_ENABLED: bindings.text("true"),
    },
  };
}

/** The production build of Postiz's two Workers, from its manifest. */
export const postizConfig: FakeAppConfig = ({ manifest, root }) => {
  const ctx = { mode: "production" };
  const handWrittenR2 = !manifest.resources?.r2?.includes("R2");
  const app = everyAppWorker({ manifest, entrypoint: "./worker/index.ts", ctx, root });
  const helper = everyAppAuxiliaryWorker({
    manifest,
    worker: "api",
    entrypoint: "../api/src/entry.worker.ts",
    ctx,
    root,
    secrets: POSTIZ_SECRETS,
    crons: [POSTIZ_CRON],
  });
  const worker = withPostizRuntime(app, app.name, handWrittenR2);
  return {
    worker: {
      ...worker,
      env: {
        ...worker.env,
        ASSETS: bindings.assets(),
        NEXT_PUBLIC_BACKEND_URL: bindings.text("/api"),
        NEXT_PUBLIC_VERSION: bindings.text("everyapp"),
      },
      // vinext's generated exclusions, verbatim.
      assets: {
        htmlHandling: "none",
        notFoundHandling: "none",
        runWorkerFirst: ["/*", "!/_next/static/*", "!/*/_next/static/*"],
      },
    },
    auxiliaryWorkers: [withPostizRuntime(helper, app.name, handWrittenR2)],
  };
};
