import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { defineConfig } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  server: {
    port: 3001,
  },
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tsConfigPaths(),
    tanstackStart(),
    viteReact(),
    tailwindcss(),
  ],
});
