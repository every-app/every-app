import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { SiteHeader, SiteTopBar } from "@/components/site-header";

// Frontmatter dates parse as UTC midnight; format in UTC so readers west of
// UTC don't see the previous day and SSR matches hydration.
export function PostDate({
  date,
  className,
}: {
  date: string;
  className?: string;
}) {
  return (
    <time dateTime={date} className={className}>
      {new Date(date).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: "UTC",
      })}
    </time>
  );
}

/** Shown on a draft post and its index card; drafts exist only under `vite dev`. */
export function DraftBadge() {
  return (
    <span className="rounded-full border border-amber-400/40 px-2 py-0.5 text-xs font-medium text-amber-300">
      Draft
    </span>
  );
}

/** The home page's colors and header, and the footer links, around a post or the blog index. */
export function BlogLayout({ children }: { children: ReactNode }) {
  return (
    <div className="dark min-h-screen bg-[#0a0f0d] text-stone-100">
      <SiteTopBar />
      <SiteHeader />
      <main>{children}</main>
      <footer className="border-t border-white/[0.08] px-6 py-10">
        <div className="mx-auto flex max-w-5xl flex-wrap gap-6 text-sm">
          <Link
            to="/blogs"
            className="text-stone-500 transition-colors hover:text-stone-300"
          >
            Blog
          </Link>
          <Link
            to="/docs/$"
            params={{ _splat: "" }}
            className="text-stone-500 transition-colors hover:text-stone-300"
          >
            Docs
          </Link>
          <a
            href="https://discord.gg/c9uGs3cFXr"
            target="_blank"
            rel="noopener noreferrer"
            className="text-stone-500 transition-colors hover:text-stone-300"
          >
            Discord
          </a>
          <a
            href="https://github.com/every-app/every-app"
            target="_blank"
            rel="noopener noreferrer"
            className="text-stone-500 transition-colors hover:text-stone-300"
          >
            GitHub
          </a>
          <Link
            to="/privacy"
            className="text-stone-500 transition-colors hover:text-stone-300"
          >
            Privacy
          </Link>
        </div>
      </footer>
    </div>
  );
}
