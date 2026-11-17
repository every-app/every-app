import { Link } from "@tanstack/react-router";
import { ArrowRight, Star } from "lucide-react";

/**
 * The star we ask for is EveryApp's, so the home page's OpenSEO chip stays
 * social proof rather than the call to action. Sticky, on an opaque base, so
 * it stays in view while the page scrolls.
 */
export function SiteTopBar() {
  return (
    <a
      href="https://github.com/every-app/every-app"
      target="_blank"
      rel="noopener noreferrer"
      className="group sticky top-0 z-50 flex min-h-10 flex-wrap items-center justify-center gap-x-2 gap-y-0.5 border-b border-white/[0.08] bg-[#0a0f0d] bg-gradient-to-r from-white/[0.02] via-white/[0.07] to-white/[0.02] px-4 py-2 text-center text-sm text-stone-300 transition-colors hover:text-white"
    >
      <span className="whitespace-nowrap">EveryApp is open source.</span>
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap font-medium text-stone-100 underline decoration-stone-600 underline-offset-4 group-hover:decoration-stone-400">
        <Star className="h-3.5 w-3.5" aria-hidden="true" />
        Star it on GitHub
      </span>
      <ArrowRight
        className="hidden h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5 sm:block"
        aria-hidden="true"
      />
    </a>
  );
}

const navLinkClass = "text-stone-400 transition-colors hover:text-white";

/** The logo and primary nav shared by the home page and the blog. */
export function SiteHeader({ className = "" }: { className?: string }) {
  return (
    <header className={`px-6 py-6 ${className}`}>
      <div className="mx-auto flex max-w-6xl items-center justify-between">
        <Link
          to="/"
          aria-label="EveryApp home"
          className="transition-opacity hover:opacity-80"
        >
          <img
            src="/transparent-logo-256.png"
            alt="EveryApp logo"
            className="h-12 w-12 opacity-80"
            width={48}
            height={48}
          />
        </Link>
        <nav aria-label="Primary" className="flex items-center gap-6 text-sm">
          <Link
            to="/blogs"
            className={navLinkClass}
            activeProps={{ className: "text-white" }}
          >
            Blog
          </Link>
          <Link to="/docs/$" params={{ _splat: "" }} className={navLinkClass}>
            Docs
          </Link>
          <a
            href="https://github.com/every-app/every-app"
            target="_blank"
            rel="noopener noreferrer"
            className={navLinkClass}
          >
            GitHub
          </a>
          <a
            href="https://discord.gg/c9uGs3cFXr"
            target="_blank"
            rel="noopener noreferrer"
            className={navLinkClass}
          >
            Discord
          </a>
        </nav>
      </div>
    </header>
  );
}
