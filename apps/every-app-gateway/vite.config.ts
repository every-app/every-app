import { execSync } from "node:child_process";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { defineConfig } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import { cloudflare } from "@cloudflare/vite-plugin";

// Build stamp shown in the bottom-right badge so a deployed gateway can be
// matched to a commit. "*" = built from a dirty working tree.
const gatewayBuild = (() => {
  try {
    const sha = execSync("git rev-parse --short HEAD").toString().trim();
    const dirty = execSync("git status --porcelain").toString().trim()
      ? "*"
      : "";
    const builtAt = new Date().toISOString().slice(0, 16).replace("T", " ");
    return `${sha}${dirty} · ${builtAt}Z`;
  } catch {
    return "unknown";
  }
})();

export default defineConfig(({ isPreview }) => ({
  define: {
    __GATEWAY_BUILD__: JSON.stringify(gatewayBuild),
  },
  server: {
    // `cf dev` forwards no port flag; PORT picks another port.
    port: Number(process.env.PORT ?? 3000),
  },
  // Previews, including the build's prerender pass, run the production
  // Worker the way a fresh deploy starts: without the local .dev.vars or
  // .env secrets, so no GATEWAY_URL and the bootstrap control plane.
  ...(isPreview ? { envDir: false as const } : {}),
  // The workspace-linked @every-app/sdk would otherwise resolve jose from
  // packages/sdk/node_modules (its devDependency). Dedupe so identity JWTs
  // use the gateway's own, audited jose.
  resolve: {
    dedupe: ["jose"],
  },
  // Source maps for the Worker bundle only: "hidden" leaves no
  // sourceMappingURL and keeps maps out of the public assets. The deploy
  // uploads them so Workers logs and Issues point at source lines.
  environments: {
    ssr: { build: { sourcemap: "hidden" } },
  },
  plugins: [
    // Cloudflare plugin must come first - it sets up the SSR environment.
    // Reads cloudflare.config.ts; local dev never touches remote resources.
    cloudflare({
      viteEnvironment: { name: "ssr" },
      inspectorPort: false,
      remoteBindings: false,
      // The build prerenders through a preview server running the
      // production Worker, whose D1 has no local id; keep it from leaving a
      // second database in .cloudflare/state next to the one `cf dev` uses.
      persistState: !isPreview,
    }),
    tsConfigPaths({
      projects: ["./tsconfig.json"],
    }),
    tanstackStart({
      spa: { enabled: true },
    }),
    viteReact(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: false,
      includeAssets: ["favicon.ico", "apple-touch-icon.png"],
      workbox: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
        navigateFallback: null,
        clientsClaim: true,
        skipWaiting: true,
      },
      devOptions: {
        enabled: false,
      },
      manifest: {
        name: "Every App",
        short_name: "Every App",
        description: "Embedded apps platform",
        theme_color: "#ffffff",
        background_color: "#ffffff",
        display: "standalone",
        start_url: "/",
        icons: [
          {
            src: "android-chrome-192x192.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "android-chrome-512x512.png",
            sizes: "512x512",
            type: "image/png",
          },
        ],
      },
    }),
  ],
  build: {
    minify: process.env.DEBUG_BUILD === "true" ? false : "esbuild",
    sourcemap: process.env.DEBUG_BUILD === "true" ? true : false,
  },
}));
