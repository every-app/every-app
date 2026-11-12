import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Check,
  ChevronDown,
  Copy,
  Eye,
  GitFork,
  Link as LinkIcon,
  Scale,
  Star,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  APP_VERSION,
  DOWNLOAD_URLS,
  EVERY_APP_REPO,
  OPENSCRIBE_CARD_PATH,
  OPENSCRIBE_REPO,
  type Repo,
} from "@/lib/openscribe-data";
import { buildPageSeo } from "@/lib/seo";

const title = "OpenScribe: open-source AI meeting notes for Mac";
const description =
  "Open source alternative to Wispr Flow and Granola. Don't give another company all your meeting notes and voice dictations: transcribe them and save them in your own Cloudflare account.";

// The commands the desktop app's onboarding shows
// (apps/desktop/src/shared/setup.ts), with the public repository.
const SETUP_COMMANDS = {
  cli: "npm install -g everyapp",
  gateway: "everyapp setup",
  scribe: `everyapp install ${OPENSCRIBE_REPO.url}`,
};

export const Route = createFileRoute("/openscribe")({
  head: () =>
    buildPageSeo({
      title,
      description,
      path: "/openscribe",
      image: {
        path: OPENSCRIBE_CARD_PATH,
        alt: `${OPENSCRIBE_REPO.owner}/${OPENSCRIBE_REPO.name} on GitHub. ${OPENSCRIBE_REPO.description}`,
      },
    }),
  component: OpenScribe,
});

const linkClass =
  "text-stone-300 underline decoration-stone-600 underline-offset-4 transition-colors hover:text-white hover:decoration-stone-400";

const reasons: Array<{ title: string; line: string }> = [
  {
    title: "Stored in your own cloud",
    line: "Transcripts and notes are kept in your Cloudflare account, not ours.",
  },
  {
    title: "Shared with your team",
    line: "The people you invite to your Gateway sign in and see the meetings you share.",
  },
  {
    title: "On every device",
    line: "Read your notes in a browser on any computer or phone.",
  },
  {
    title: "Shareable with participants",
    line: "Send the people who were in the meeting a link to its notes.",
  },
];

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      // The command is on the page to select by hand.
    }
  };

  return (
    <div className="mt-3 flex items-center gap-2 rounded-md border border-stone-800 bg-[#141a17] py-1.5 pr-1.5 pl-4">
      <code className="min-w-0 flex-1 py-1.5 font-mono text-sm break-all text-stone-100">
        {command}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? "Copied" : `Copy: ${command}`}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded text-stone-400 transition-colors hover:bg-white/[0.06] hover:text-white"
      >
        {copied ? (
          <Check className="h-4 w-4" aria-hidden="true" />
        ) : (
          <Copy className="h-4 w-4" aria-hidden="true" />
        )}
      </button>
    </div>
  );
}

// Apple's logo, as on any "Download for macOS" button.
function AppleLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" />
    </svg>
  );
}

/**
 * One button: the Apple Silicon build, with the Intel one behind the arrow.
 * The menu is a <details>, so it opens without JavaScript; with it, a click
 * outside or Escape closes it.
 */
function DownloadButton() {
  const menuRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const close = (event: Event) => {
      const menu = menuRef.current;
      if (!menu?.open) return;
      if (event instanceof KeyboardEvent) {
        if (event.key === "Escape") menu.open = false;
      } else if (!menu.contains(event.target as Node)) {
        menu.open = false;
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, []);

  return (
    <div>
      <div className="inline-flex text-[#0a0f0d]">
        <a
          href={DOWNLOAD_URLS.appleSilicon}
          className="inline-flex h-14 items-center gap-3 rounded-l-md bg-stone-100 pr-6 pl-5 text-base font-medium transition-colors hover:bg-white"
        >
          <AppleLogo className="h-5 w-5 -translate-y-px" />
          Download for macOS
        </a>
        <details ref={menuRef} className="group relative">
          <summary
            aria-label="Other downloads"
            className="ml-px flex h-14 w-12 cursor-pointer list-none items-center justify-center rounded-r-md bg-stone-100 transition-colors hover:bg-white [&::-webkit-details-marker]:hidden"
          >
            <ChevronDown
              className="h-4 w-4 transition-transform group-open:rotate-180"
              aria-hidden="true"
            />
          </summary>
          <div className="absolute top-full right-0 z-10 mt-2 w-56 overflow-hidden rounded-md border border-stone-800 bg-[#141a17] py-1 text-sm text-stone-200 shadow-xl">
            <a
              href={DOWNLOAD_URLS.appleSilicon}
              className="block px-4 py-2.5 transition-colors hover:bg-white/[0.06] hover:text-white"
            >
              Apple Silicon
              <span className="block text-xs text-stone-500">
                Macs from late 2020 on
              </span>
            </a>
            <a
              href={DOWNLOAD_URLS.intel}
              className="block px-4 py-2.5 transition-colors hover:bg-white/[0.06] hover:text-white"
            >
              Intel
              <span className="block text-xs text-stone-500">Older Macs</span>
            </a>
          </div>
        </details>
      </div>
      <p className="mt-4 text-sm text-stone-500">
        Every App for Mac{APP_VERSION ? ` ${APP_VERSION}` : ""}. macOS 15 or
        later.
      </p>
    </div>
  );
}

function Step({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-5">
      <span
        aria-hidden="true"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-stone-700 text-sm text-stone-300"
      >
        {number}
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="text-lg font-medium text-white">{title}</h3>
        <div className="mt-1.5 text-base leading-relaxed text-stone-400">
          {children}
        </div>
      </div>
    </li>
  );
}

function formatCount(count: number): string {
  return count >= 1000
    ? `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`
    : String(count);
}

/**
 * A repository's page header as GitHub's dark theme draws it: name and
 * visibility, the Watch / Fork / Star buttons, then the About panel. The
 * whole block is one link to the repository, so the buttons are not buttons.
 * A repository GitHub's API doesn't serve yet (not public) has no badge and
 * no counts. The colours are GitHub's; the icons are lucide's, not Octicons,
 * and there is no GitHub logo.
 */
function RepoHeader({ repo }: { repo: Repo }) {
  const actions: Array<{
    label: string;
    count: number | null;
    icon: React.ReactNode;
  }> = [
    {
      label: "Watch",
      count: repo.watchers,
      icon: <Eye className="h-4 w-4 text-[#9198a1]" aria-hidden="true" />,
    },
    {
      label: "Fork",
      count: repo.forks,
      icon: <GitFork className="h-4 w-4 text-[#9198a1]" aria-hidden="true" />,
    },
    {
      label: "Star",
      count: repo.stars,
      icon: <Star className="h-4 w-4 text-[#9198a1]" aria-hidden="true" />,
    },
  ];

  return (
    <a
      href={repo.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${repo.owner}/${repo.name} on GitHub`}
      className="group block rounded-md border border-[#3d444d] bg-[#0d1117] font-[-apple-system,BlinkMacSystemFont,'Segoe_UI','Noto_Sans',Helvetica,Arial,sans-serif] text-[#f0f6fc] transition-colors hover:border-[#656c76]"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-b border-[#3d444d] px-4 py-4 sm:px-5">
        <div className="flex min-w-0 items-center gap-2">
          <img
            src="/android-chrome-192x192.png"
            alt=""
            width={24}
            height={24}
            className="h-6 w-6 shrink-0 rounded-md"
          />
          <span className="min-w-0 truncate text-xl">
            <span className="text-[#9198a1]">{repo.owner}</span>
            <span className="mx-1 text-[#9198a1]">/</span>
            <span className="font-semibold group-hover:text-[#4493f8]">
              {repo.name}
            </span>
          </span>
          {repo.public ? (
            <span className="shrink-0 rounded-full border border-[#3d444d] px-2 py-px text-xs font-medium text-[#9198a1]">
              Public
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {actions.map((action) => (
            <span
              key={action.label}
              className="inline-flex h-7 items-center gap-2 rounded-md border border-[#3d444d] bg-[#212830] px-3 text-xs font-medium"
            >
              {action.icon}
              {action.label}
              {action.count === null ? null : (
                <span className="rounded-full bg-[#2f3742] px-1.5 py-px">
                  {formatCount(action.count)}
                </span>
              )}
            </span>
          ))}
        </div>
      </div>

      <div className="px-4 py-4 sm:px-5">
        <p className="text-base font-semibold">About</p>
        <p className="mt-2 text-base leading-normal">{repo.description}</p>
        {repo.homepage ? (
          <p className="mt-3 flex items-center gap-2 text-base font-semibold text-[#4493f8]">
            <LinkIcon className="h-4 w-4 text-[#9198a1]" aria-hidden="true" />
            {repo.homepage.replace(/^https?:\/\//, "")}
          </p>
        ) : null}
        {repo.topics.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {repo.topics.map((topic) => (
              <span
                key={topic}
                className="rounded-full bg-[#388bfd1a] px-2.5 py-0.5 text-xs font-medium text-[#4493f8]"
              >
                {topic}
              </span>
            ))}
          </div>
        ) : null}
        {repo.license ? (
          <p className="mt-3 flex items-center gap-2 text-sm text-[#9198a1]">
            <Scale className="h-4 w-4" aria-hidden="true" />
            {repo.license} license
          </p>
        ) : null}

        {repo.languages.length > 0 ? (
          <div className="mt-4">
            <div
              className="flex h-2 gap-0.5 overflow-hidden rounded-full"
              aria-hidden="true"
            >
              {repo.languages.map((language) => (
                <span
                  key={language.name}
                  style={{
                    flexGrow: language.percent,
                    backgroundColor: language.color,
                  }}
                />
              ))}
            </div>
            <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
              {repo.languages.map((language) => (
                <li key={language.name} className="flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: language.color }}
                  />
                  <span className="font-semibold">{language.name}</span>
                  <span className="text-[#9198a1]">{language.percent}%</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </a>
  );
}

function OpenScribe() {
  return (
    <div className="min-h-screen bg-[#0a0f0d] text-stone-100">
      <header className="px-6 py-6">
        <div className="mx-auto flex max-w-4xl items-center justify-between">
          <Link to="/" aria-label="EveryApp home">
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
              to="/docs/$"
              params={{ _splat: "" }}
              className="text-stone-400 transition-colors hover:text-white"
            >
              Docs
            </Link>
            <a
              href={OPENSCRIBE_REPO.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-stone-400 transition-colors hover:text-white"
            >
              GitHub
            </a>
            <a
              href="https://discord.gg/c9uGs3cFXr"
              target="_blank"
              rel="noopener noreferrer"
              className="text-stone-400 transition-colors hover:text-white"
            >
              Discord
            </a>
          </nav>
        </div>
      </header>

      <main>
        <section className="px-6 pt-10 pb-14 md:pt-14">
          <div className="mx-auto w-full max-w-4xl">
            <h1 className="landing-reveal mb-6 max-w-3xl text-balance text-[clamp(2.25rem,5.5vw,3.75rem)] font-semibold leading-[1.08] tracking-[-0.015em] text-white">
              Open source alternative to Wispr Flow and Granola
            </h1>
            <p
              className="landing-reveal mb-8 max-w-2xl text-[clamp(1.125rem,2vw,1.375rem)] leading-snug text-stone-300"
              style={{ animationDelay: "50ms" }}
            >
              Own your transcriptions. Don&apos;t give another company all your
              meeting notes and voice dictations. Transcribe them and save them
              in your own Cloudflare account.
            </p>
            <div className="landing-reveal" style={{ animationDelay: "100ms" }}>
              <DownloadButton />
            </div>
          </div>
        </section>

        <section aria-labelledby="on-github" className="px-6 pb-16">
          <div className="mx-auto w-full max-w-4xl">
            <h2
              id="on-github"
              className="mb-5 text-xl font-semibold text-white md:text-2xl"
            >
              Give our repos a star on GitHub ⭐
            </h2>
            <div className="space-y-4">
              <RepoHeader repo={OPENSCRIBE_REPO} />
              <RepoHeader repo={EVERY_APP_REPO} />
            </div>
          </div>
        </section>

        <section
          aria-labelledby="why"
          className="border-t border-stone-900 px-6 py-16"
        >
          <div className="mx-auto w-full max-w-4xl">
            <h2
              id="why"
              className="mb-10 text-2xl font-semibold text-white md:text-3xl"
            >
              Your meetings stay yours
            </h2>
            <ul className="grid gap-x-10 gap-y-8 sm:grid-cols-2">
              {reasons.map((reason) => (
                <li key={reason.title}>
                  <h3 className="text-lg font-medium text-white">
                    {reason.title}
                  </h3>
                  <p className="mt-1.5 text-base leading-relaxed text-stone-400">
                    {reason.line}
                  </p>
                </li>
              ))}
            </ul>
            <p className="mt-10 max-w-2xl text-base leading-relaxed text-stone-400">
              The{" "}
              <Link
                to="/docs/$"
                params={{ _splat: "how-it-works" }}
                className={linkClass}
              >
                Every App Gateway
              </Link>{" "}
              makes this possible by simplifying hosting in your Cloudflare
              account.
            </p>
            <p className="mt-3 text-base text-stone-500">
              Coming later: automatic emails.
            </p>
          </div>
        </section>

        <section
          aria-labelledby="set-up"
          className="border-t border-stone-900 px-6 py-16"
        >
          <div className="mx-auto w-full max-w-4xl">
            <h2
              id="set-up"
              className="mb-10 text-2xl font-semibold text-white md:text-3xl"
            >
              Set it up
            </h2>
            <ol className="max-w-2xl space-y-10">
              <Step number={1} title="Download the Mac app">
                <p>
                  Open it and it walks you through the rest: the next two steps
                  are the commands it shows.
                </p>
                <div className="mt-5">
                  <DownloadButton />
                </div>
              </Step>
              <Step number={2} title="Set up your Gateway">
                <p>
                  You need a Cloudflare account on Workers Paid and a domain on
                  Cloudflare. It takes about 15 minutes.{" "}
                  <Link
                    to="/docs/$"
                    params={{ _splat: "quickstart" }}
                    className={linkClass}
                  >
                    The full guide
                  </Link>
                </p>
                <CopyCommand command={SETUP_COMMANDS.cli} />
                <CopyCommand command={SETUP_COMMANDS.gateway} />
              </Step>
              <Step number={3} title="Install OpenScribe on it">
                <p>This deploys OpenScribe to your Cloudflare account.</p>
                <CopyCommand command={SETUP_COMMANDS.scribe} />
              </Step>
              <Step number={4} title="Sign in">
                <p>
                  Back in the app, enter your Gateway&apos;s address and sign
                  in.
                </p>
              </Step>
            </ol>
          </div>
        </section>
      </main>

      <footer className="border-t border-stone-900 px-6 py-12">
        <div className="mx-auto flex w-full max-w-4xl flex-wrap gap-6 text-sm">
          <Link
            to="/"
            className="text-stone-500 transition-colors hover:text-stone-300"
          >
            EveryApp
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
            href={EVERY_APP_REPO.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-stone-500 transition-colors hover:text-stone-300"
          >
            GitHub
          </a>
          <Link
            to="/blogs"
            className="text-stone-500 transition-colors hover:text-stone-300"
          >
            Blog
          </Link>
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
