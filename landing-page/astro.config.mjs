import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import tailwind from "@astrojs/tailwind";
// import cloudflare from '@astrojs/cloudflare';

// https://astro.build/config
export default defineConfig({
  output: "static",
  redirects: {
    "/docs": "/docs/quickstart",
  },
  integrations: [
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
        Head: "./src/components/Head.astro",
        Header: "./src/components/Header.astro",
      },
      social: {
        github: "https://github.com/every-app/every-app",
        discord: "https://discord.gg/EpwPGyDn",
      },
      sidebar: [
        {
          label: "Getting Started",
          items: [{ slug: "docs/quickstart" }, { slug: "docs/build-an-app" }],
        },
      ],
      // Disable the default 404 route so we can have custom pages at root
      disable404Route: true,
    }),
  ],
});
