import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const shared = { "@shared": resolve(__dirname, "src/shared") };

export default defineConfig({
  main: {
    resolve: { alias: shared },
    build: { externalizeDeps: true },
  },
  preload: {
    resolve: { alias: shared },
    // A sandboxed preload can only require "electron" and a few built-ins, so it's bundled whole.
    build: { externalizeDeps: false },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    resolve: { alias: { ...shared, "@renderer": resolve(__dirname, "src/renderer/src") } },
    plugins: [react(), tailwindcss()],
    // The window loads from disk, but parsing still costs: minify, and let each page be its own
    // chunk (src/renderer/src/router.tsx).
    // Two pages: the window (index.html) and the floating recorder (pill.html, src/main/pill.ts).
    build: {
      minify: true,
      rollupOptions: {
        input: { index: resolve(__dirname, "src/renderer/index.html"), pill: resolve(__dirname, "src/renderer/pill.html") },
      },
    },
  },
});
