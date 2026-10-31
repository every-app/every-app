import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

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

/** The home page's colors and header, around a post or the blog index. */
export function BlogLayout({ children }: { children: ReactNode }) {
  return (
    <div className="dark min-h-screen bg-[#0a0f0d] text-stone-100">
      <header className="border-b border-white/[0.08] px-6 py-5">
        <div className="mx-auto flex max-w-5xl items-center justify-between">
          <Link to="/" className="transition-opacity hover:opacity-80">
            <img
              src="/transparent-logo-256.png"
              alt="EveryApp"
              className="h-9 w-9 opacity-80"
              width={36}
              height={36}
            />
          </Link>
          <nav aria-label="Primary" className="flex items-center gap-6 text-sm">
            <Link
              to="/blogs"
              className="text-stone-400 transition-colors hover:text-white"
              activeProps={{ className: "text-white" }}
            >
              Blog
            </Link>
            <Link
              to="/docs/$"
              params={{ _splat: "" }}
              className="text-stone-400 transition-colors hover:text-white"
            >
              Docs
            </Link>
            <a
              href="https://github.com/every-app/every-app"
              target="_blank"
              rel="noopener noreferrer"
              className="text-stone-400 transition-colors hover:text-white"
            >
              GitHub
            </a>
          </nav>
        </div>
      </header>
      <main>{children}</main>
    </div>
  );
}
