import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { OG_IMAGE_PATH, toCanonicalUrl } from "@/lib/seo";
import { joinWaitlist } from "@/lib/waitlist.functions";

const homeTitle = "Every App: Make every app open source";
const homeDescription =
  "Own your tools. Customize your tools. Pay as you go. Every App puts the web apps you build online, in your own Cloudflare account. Open source, alpha.";
// What the Open Graph card says, so a screen reader hears the same words a sighted reader sees.
const ogImageAlt = "Every App. Make every app open source.";

const openSeoRepo = "every-app/open-seo";
// Seed value so the badge never renders empty; refreshed from the GitHub API on load.
const openSeoStarsFallback = 24814;

/**
 * The four apps, one line each, word for word the lines in the README and the
 * docs home (the orchestrating thread keeps them identical). Only OpenSEO
 * links out: the other three repositories are not public yet (TODO.md,
 * "README and launch copy").
 */
const apps: Array<{ name: string; line: string; href?: string }> = [
  {
    name: "OpenSEO",
    line: "SEO research, rank tracking, site audits and AI visibility for your sites.",
    href: `https://github.com/${openSeoRepo}`,
  },
  {
    name: "OpenCRM",
    line: "Companies, contacts and deals, kept up to date by a research agent.",
  },
  {
    name: "OpenAnalytics",
    line: "Web analytics for your sites. No cookies, no stored IP addresses.",
  },
  {
    name: "Agentic Inbox",
    line: "A team inbox with an AI agent that reads, drafts and sends email on your domain.",
  },
];

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: homeTitle },
      { name: "description", content: homeDescription },
      { property: "og:type", content: "website" },
      { property: "og:title", content: homeTitle },
      { property: "og:description", content: homeDescription },
      { property: "og:url", content: toCanonicalUrl("/") },
      { property: "og:image", content: toCanonicalUrl(OG_IMAGE_PATH) },
      { property: "og:image:alt", content: ogImageAlt },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: homeTitle },
      { name: "twitter:description", content: homeDescription },
      { name: "twitter:image", content: toCanonicalUrl(OG_IMAGE_PATH) },
      { name: "twitter:image:alt", content: ogImageAlt },
    ],
    links: [{ rel: "canonical", href: toCanonicalUrl("/") }],
  }),
  component: Home,
});

function formatStars(count: number) {
  if (count < 1000) return String(count);
  return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

function useOpenSeoStars() {
  const [stars, setStars] = useState(openSeoStarsFallback);

  useEffect(() => {
    let active = true;

    fetch(`https://api.github.com/repos/${openSeoRepo}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const count = (data as { stargazers_count?: number } | null)
          ?.stargazers_count;
        if (active && typeof count === "number") {
          setStars(count);
        }
      })
      .catch(() => {});

    return () => {
      active = false;
    };
  }, []);

  return stars;
}

type WaitlistStatus = "idle" | "submitting" | "success" | "error";

function WaitlistForm() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<WaitlistStatus>("idle");

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (status === "submitting") return;

    setStatus("submitting");
    try {
      await joinWaitlist({ data: email });
      setStatus("success");
    } catch {
      setStatus("error");
    }
  };

  if (status === "success") {
    return (
      <div className="flex min-h-12 items-center">
        <p className="text-base text-stone-200">
          Thanks. We&apos;ll keep you posted.
        </p>
      </div>
    );
  }

  return (
    <div className="w-full">
      <form
        className="flex w-full max-w-md flex-col gap-2 sm:flex-row"
        onSubmit={handleSubmit}
      >
        <input
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
          aria-label="Email address"
          className="h-12 w-full rounded-md border border-stone-800 bg-[#141a17] px-4 text-base text-stone-100 placeholder:text-stone-600 outline-none transition-colors focus:border-stone-600 sm:flex-1"
        />
        <button
          type="submit"
          disabled={status === "submitting"}
          className="h-12 shrink-0 rounded-md bg-stone-100 px-5 text-sm font-medium text-[#0a0f0d] transition-colors hover:bg-white disabled:opacity-60"
        >
          {status === "submitting" ? "Sending…" : "Keep me posted"}
        </button>
      </form>
      {status === "error" ? (
        <p className="mt-2 text-sm text-red-400">
          Something went wrong. Please try again.
        </p>
      ) : null}
    </div>
  );
}

const linkClass =
  "text-stone-300 underline decoration-stone-600 underline-offset-4 transition-colors hover:text-white hover:decoration-stone-400";

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-[#141a17] px-1.5 py-0.5 font-mono text-[0.9em] text-stone-200">
      {children}
    </code>
  );
}

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className="border-t border-stone-900 py-16"
    >
      <div className="mx-auto w-full max-w-6xl px-6">
        <div className="max-w-2xl">
          <h2
            id={`${id}-title`}
            className="mb-6 text-2xl font-semibold tracking-tight text-white"
          >
            {title}
          </h2>
          {children}
        </div>
      </div>
    </section>
  );
}

function Home() {
  const stars = useOpenSeoStars();

  return (
    <div className="relative min-h-screen bg-[#0a0f0d] text-stone-100">
      <header className="absolute top-0 left-0 right-0 px-6 py-6">
        <div className="mx-auto flex max-w-6xl items-center justify-between">
          <img
            src="/transparent-logo-256.png"
            alt="Every App logo"
            className="h-12 w-12 opacity-80"
            width={48}
            height={48}
          />
          <nav aria-label="Primary" className="flex items-center gap-6 text-sm">
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

      <main>
        {/* Clears the absolutely positioned header: at phone width the hero is taller than the screen and would start under it. */}
        <div className="px-6 pt-28 pb-16">
          <div className="mx-auto w-full max-w-6xl">
            <div className="max-w-2xl">
              <h1 className="landing-reveal mb-8 text-[clamp(3rem,10vw,7rem)] font-bold leading-none tracking-tight text-white">
                EVERY APP
              </h1>
              <blockquote
                className="landing-reveal mb-8 border-l-2 border-stone-600 pl-5 text-[clamp(1.5rem,3vw,2rem)] font-normal leading-snug text-white"
                style={{ animationDelay: "100ms" }}
              >
                <p>Make every app open source</p>
              </blockquote>
              <div
                className="landing-reveal mb-8 space-y-1 text-lg text-stone-200 sm:text-xl"
                style={{ animationDelay: "150ms" }}
              >
                <p>Own your tools. Customize your tools.</p>
                <p>Pay as you go.</p>
                <p>Build internal apps with peace of mind.</p>
              </div>
              <div
                className="landing-reveal mb-10 max-w-xl space-y-4 text-base text-stone-400"
                style={{ animationDelay: "200ms" }}
              >
                <p>
                  Every App puts the web apps you build online, in your own
                  Cloudflare account. Each app gets a web address, a database
                  and a sign-in. One Gateway sits in front of them all and gives
                  each app only what you allow.
                </p>
                <p>
                  Made for a solo founder or a team of three or four who build
                  their own tools with Claude Code, Codex or Cursor.
                </p>
                <p>
                  Open source, very powerful, alpha. Powerful: your apps run in
                  your Cloudflare account with everything it can do. Alpha:
                  moving fast, and trying not to break things. A deploy keeps
                  your data and saves a restore point first.
                </p>
              </div>

              <div
                className="landing-reveal flex flex-wrap items-center gap-3"
                style={{ animationDelay: "250ms" }}
              >
                <Link
                  to="/docs/$"
                  params={{ _splat: "" }}
                  className="inline-flex h-12 items-center rounded-md bg-stone-100 px-5 text-sm font-medium text-[#0a0f0d] transition-colors hover:bg-white"
                >
                  Get started
                </Link>
                <a
                  href="https://github.com/every-app/every-app"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-12 items-center rounded-md border border-stone-700 px-5 text-sm font-medium text-stone-200 transition-colors hover:border-stone-500 hover:text-white"
                >
                  View on GitHub
                </a>
              </div>
              <p
                className="landing-reveal mt-4 max-w-xl text-sm text-stone-400"
                style={{ animationDelay: "300ms" }}
              >
                Free and open source, MIT. You pay Cloudflare: Workers Paid, $5
                a month, then usage. We strongly recommend{" "}
                <Link
                  to="/docs/$"
                  params={{ _splat: "access" }}
                  className={linkClass}
                >
                  Cloudflare Access
                </Link>{" "}
                in front of your Gateway: one command, free for up to 50 people.
              </p>
            </div>
          </div>
        </div>

        <Section id="apps" title="Apps off the shelf">
          <p className="mb-6 text-base text-stone-400">
            Four open-source apps, built for your Gateway. Run one as it is, or
            fork it as the starting recipe for your own.
          </p>
          <ul className="mb-6 space-y-3 text-base text-stone-300">
            {apps.map((app) => (
              <li key={app.name}>
                {app.href ? (
                  <a
                    href={app.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-white underline decoration-stone-600 underline-offset-4 transition-colors hover:decoration-stone-400"
                  >
                    {app.name}
                  </a>
                ) : (
                  <span className="font-medium text-white">{app.name}</span>
                )}
                <span className="text-stone-500">: </span>
                {app.line}
              </li>
            ))}
          </ul>
          <p className="max-w-xl text-base text-stone-400">
            <Code>
              pnpm everyapp install https://github.com/every-app/&lt;repo&gt;
            </Code>{" "}
            from your Every App folder installs one; run it again to update.
            OpenSEO needs a DataForSEO key, OpenCRM a Context.dev key,
            OpenAnalytics a secret of its own. The three that use AI share one
            key on the Gateway.
          </p>
        </Section>

        <Section id="gateway" title="The Gateway, your home base">
          <p className="mb-6 text-base text-stone-400">
            One Gateway at <Code>apps.yourcompany.com</Code> is where you and
            your team build internal apps with peace of mind. You and the people
            you invite sign in there and open your apps.
          </p>
          <ul className="mb-6 max-w-xl space-y-3 text-base text-stone-300">
            <li>
              Nobody can sign up unless you invite them. No login page in any
              app.
            </li>
            <li>
              Each app gets only what you allow. It sees a short-lived signed
              note of who you are, made for that app alone, and the secrets you
              set for it. Your AI keys stay on the Gateway.
            </li>
            <li>
              Apps have no public address of their own. Every visit passes the
              Gateway. The only routes open without sign-in are the ones an app
              declares public, and the deploy prints them.
            </li>
            <li>Each app has its own database.</li>
            <li>
              Describe an app. Your coding agent builds it, and it runs behind
              the same sign-in. A skill in every app tells Claude Code, Codex or
              Cursor the CLI, the manifest and the rules, so it never writes a
              login page.
            </li>
            <li>
              One MCP address, <Code>https://apps.yourcompany.com/mcp</Code>,
              connects claude.ai, ChatGPT, Claude Code and Cursor to your apps.
              Tools that delete data stay hidden from agents.
            </li>
          </ul>
          <p className="mb-6 max-w-xl text-base text-stone-300">
            We strongly recommend Cloudflare Access before you invite anyone.{" "}
            <Code>pnpm everyapp access on</Code> adds a second sign-in at
            Cloudflare&apos;s edge, in front of the Gateway and your apps.{" "}
            <Link
              to="/docs/$"
              params={{ _splat: "access" }}
              className={linkClass}
            >
              Cloudflare Access
            </Link>
          </p>
          <p className="max-w-xl text-base text-stone-400">
            Anyone who can sign in to your Cloudflare account can deploy apps
            and change the Gateway. Only give that access to people you fully
            trust, and turn on two-factor for that account. The{" "}
            <a
              href="https://github.com/every-app/every-app/blob/main/docs/threat-model.md"
              target="_blank"
              rel="noopener noreferrer"
              className={linkClass}
            >
              threat model
            </a>{" "}
            says what is promised, to whom, where each promise is enforced, and
            what is still open.
          </p>
        </Section>

        <Section id="start" title="How you start">
          <p className="mb-6 text-base text-stone-400">
            Setting up your Gateway takes about 15 minutes.
          </p>
          <pre className="mb-6 overflow-x-auto rounded-md border border-stone-800 bg-[#0f1512] p-4 font-mono text-sm leading-relaxed text-stone-200">
            <code>{`git clone https://github.com/every-app/every-app.git
cd every-app
pnpm install
pnpm everyapp setup --domain apps.yourcompany.com   # about 15 minutes
pnpm everyapp create my-app                         # a simple todo app
cd apps/my-app
pnpm run deploy`}</code>
          </pre>
          <ul className="max-w-xl space-y-3 text-base text-stone-300">
            <li>
              The deploy prints the app&apos;s address, who can open it, and its
              public routes.
            </li>
            <li>
              Open <Code>apps/my-app</Code> in Claude Code, Codex or Cursor and
              say what you want.
            </li>
            <li>
              Or{" "}
              <Link
                to="/docs/$"
                params={{ _splat: "gateway" }}
                hash="or-let-your-coding-agent-do-it"
                className={linkClass}
              >
                paste one prompt
              </Link>{" "}
              and let your coding agent do the setup.
            </li>
            <li>
              Updating is <Code>git pull</Code>, <Code>pnpm install</Code>, then{" "}
              <Code>pnpm everyapp update</Code>. When something must change, the
              release notes say so.
            </li>
            <li>
              You need Node.js 22.18 or newer, pnpm and git; a Cloudflare
              account on Workers Paid; a domain on Cloudflare.{" "}
              <Link
                to="/docs/$"
                params={{ _splat: "" }}
                hash="what-you-need"
                className={linkClass}
              >
                What you need
              </Link>
            </li>
          </ul>
        </Section>
      </main>

      <footer className="border-t border-stone-900 py-16">
        <div className="mx-auto w-full max-w-6xl px-6">
          <div className="max-w-2xl">
            <p className="mb-3 text-sm text-stone-400">
              Hear about releases and breaking changes:
            </p>
            <WaitlistForm />

            <div className="mt-16 flex flex-wrap items-center gap-4">
              <p className="text-sm text-stone-400">
                From the makers of{" "}
                <a
                  href="https://openseo.so"
                  target="_blank"
                  rel="noopener noreferrer"
                  className={linkClass}
                >
                  openseo.so
                </a>
              </p>
              <a
                href={`https://github.com/${openSeoRepo}`}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`OpenSEO on GitHub, ${stars} stars`}
                className="inline-flex items-center gap-2 rounded-full border border-stone-800 px-4 py-1.5 text-sm text-stone-400 transition-colors hover:border-stone-600 hover:text-stone-200"
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M12 .3a12 12 0 0 0-3.8 23.38c.6.12.83-.26.83-.57L9 21.07c-3.34.72-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.08-.74.09-.73.09-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.8 1.3 3.49 1 .1-.78.42-1.31.76-1.61-2.66-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.11-3.18 0 0 1-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.28-1.55 3.29-1.23 3.29-1.23.65 1.66.24 2.88.12 3.18a4.65 4.65 0 0 1 1.23 3.22c0 4.61-2.8 5.63-5.48 5.92.42.36.81 1.1.81 2.22l-.01 3.29c0 .31.2.69.82.57A12 12 0 0 0 12 .3Z" />
                </svg>
                <span>OpenSEO</span>
                <span className="h-3.5 w-px bg-stone-800" aria-hidden="true" />
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                </svg>
                <span className="font-mono tabular-nums">
                  {formatStars(stars)}
                </span>
              </a>
              <Link
                to="/privacy"
                className="text-sm text-stone-500 transition-colors hover:text-stone-300"
              >
                Privacy
              </Link>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
