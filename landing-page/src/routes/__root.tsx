import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import * as React from "react";
import appCss from "@/styles/app.css?url";
import { RootProvider } from "fumadocs-ui/provider/tanstack";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      {
        title: "Every App - Make every app open source",
      },
      {
        name: "description",
        content:
          "Make every app open source. Build what you want to exist. Share it easily with others. Self host unlimited apps on Cloudflare for $5/month.",
      },
      { property: "og:type", content: "website" },
      {
        property: "og:title",
        content: "Every App - Make every app open source",
      },
      {
        property: "og:description",
        content:
          "Make every app open source. Build what you want to exist. Share it easily with others. Self host unlimited apps on Cloudflare for $5/month.",
      },
      { property: "og:image", content: "/OpenGraphPreview.png" },
      {
        property: "og:image:alt",
        content: "Every App - Make every app open source",
      },
      { name: "twitter:card", content: "summary_large_image" },
      {
        name: "twitter:title",
        content: "Every App - Make every app open source",
      },
      {
        name: "twitter:description",
        content:
          "Make every app open source. Build what you want to exist. Share it easily with others. Self host unlimited apps on Cloudflare for $5/month.",
      },
      { name: "twitter:image", content: "/OpenGraphPreview.png" },
      {
        name: "twitter:image:alt",
        content: "Every App - Make every app open source",
      },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", type: "image/x-icon", href: "/favicon.ico" },
      {
        rel: "apple-touch-icon",
        sizes: "180x180",
        href: "/apple-touch-icon.png",
      },
      {
        rel: "icon",
        type: "image/png",
        sizes: "32x32",
        href: "/favicon-32x32.png",
      },
      {
        rel: "icon",
        type: "image/png",
        sizes: "16x16",
        href: "/favicon-16x16.png",
      },
      { rel: "manifest", href: "/manifest.json" },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="flex flex-col min-h-screen">
        <RootProvider>{children}</RootProvider>
        <Scripts />
      </body>
    </html>
  );
}
