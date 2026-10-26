import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { defineConfig } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  server: {
    // `cf dev` forwards no port flag; `everyapp dev` passes the port in PORT.
    host: "127.0.0.1",
    port: Number(process.env.PORT ?? 3001),
    strictPort: true,
  },
  // Source maps for the Worker bundle only: "hidden" leaves no
  // sourceMappingURL and keeps maps out of the public assets. The deploy
  // uploads them so Workers logs and Issues point at source lines.
  environments: {
    ssr: { build: { sourcemap: "hidden" } },
  },
  plugins: [
    // Reads cloudflare.config.ts. Local dev never touches remote resources.
    cloudflare({ viteEnvironment: { name: "ssr" }, remoteBindings: false }),
    tsConfigPaths(),
    tanstackStart(),
    viteReact(),
    tailwindcss(),
  ],
});
