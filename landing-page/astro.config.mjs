import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import tailwind from "@astrojs/tailwind";
import { toStarlightSidebar } from "./src/docs-config.mjs";
// import cloudflare from '@astrojs/cloudflare';

const disableStarlightAutoSitemap = {
  name: "@astrojs/sitemap",
};

// https://astro.build/config
export default defineConfig({
  output: "static",
  site: "https://everyapp.dev",
  redirects: {
    "/docs": "/docs/introduction",
  },
  integrations: [
    disableStarlightAutoSitemap,
    // TODO Investigate this
    tailwind({
      applyBaseStyles: false,
    }),
    starlight({
      title: "Every App",
      description: "Every App Docs - Make every app open source",
      logo: {
        src: "./public/transparent-logo.png",
      },
      customCss: ["./src/styles/custom.css"],
      components: {
        Header: "./src/components/Header.astro",
      },
      head: [
        // Custom favicons
        {
          tag: "link",
          attrs: {
            rel: "icon",
            type: "image/x-icon",
            href: "/favicon.ico",
          },
        },
        {
          tag: "link",
          attrs: {
            rel: "apple-touch-icon",
            sizes: "180x180",
            href: "/apple-touch-icon.png",
          },
        },
        {
          tag: "link",
          attrs: {
            rel: "icon",
            type: "image/png",
            sizes: "32x32",
            href: "/favicon-32x32.png",
          },
        },
        {
          tag: "link",
          attrs: {
            rel: "icon",
            type: "image/png",
            sizes: "16x16",
            href: "/favicon-16x16.png",
          },
        },
        {
          tag: "link",
          attrs: {
            rel: "manifest",
            href: "/manifest.json",
          },
        },
      ],
      social: {
        github: "https://github.com/every-app/every-app",
        discord: "https://discord.gg/c9uGs3cFXr",
      },
      sidebar: toStarlightSidebar(),
      // Disable the default 404 route so we can have custom pages at root
      disable404Route: true,
    }),
  ],
});
