import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { OG_IMAGE_PATH, toCanonicalUrl } from "@/lib/seo";
import { joinWaitlist } from "@/lib/waitlist.functions";

const homeTitle =
  "Every App - Your apps, online, in your own Cloudflare account";
const homeDescription =
  "Open source and alpha. Every App puts the web apps you build online, in your own Cloudflare account, each with an address, a database and a sign-in.";

const openSeoRepo = "every-app/open-seo";
// Seed value so the badge never renders empty; refreshed from the GitHub API on load.
const openSeoStarsFallback = 24693;

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
      { property: "og:image:alt", content: homeTitle },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: homeTitle },
      { name: "twitter:description", content: homeDescription },
      { name: "twitter:image", content: toCanonicalUrl(OG_IMAGE_PATH) },
      { name: "twitter:image:alt", content: homeTitle },
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

function Home() {
  const stars = useOpenSeoStars();

  return (
    <main className="relative min-h-screen bg-[#0a0f0d] text-stone-100">
      <header className="absolute top-0 left-0 right-0 px-6 py-6">
        <div className="mx-auto flex max-w-6xl items-center justify-between">
          <img
            src="/transparent-logo-256.png"
            alt="Every App Logo"
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

      {/* Clears the absolutely positioned header: at phone width the hero is taller than the screen and would start under it. */}
      <div className="flex min-h-screen items-center px-6 pt-28 pb-16">
        <div className="mx-auto w-full max-w-6xl">
          <div className="max-w-2xl">
            <h1 className="landing-reveal mb-6 text-[clamp(3rem,10vw,7rem)] font-bold leading-none tracking-tight text-white">
              EVERY APP
            </h1>
            <p
              className="landing-reveal mb-6 text-[clamp(1.5rem,3vw,2rem)] font-normal text-white"
              style={{ animationDelay: "100ms" }}
            >
              Make every app open source
            </p>
            <p
              className="landing-reveal mb-10 max-w-xl text-base text-stone-400"
              style={{ animationDelay: "150ms" }}
            >
              Every App puts the apps you build online, in your own Cloudflare
              account. Each app gets an address, a database and a sign-in. Open
              source and very powerful. Alpha: moving fast, and trying not to
              introduce breaking changes. Made for a solo founder or a
              three-person startup shipping tools with a coding agent.
            </p>

            <div
              className="landing-reveal flex flex-wrap items-center gap-3"
              style={{ animationDelay: "200ms" }}
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
              className="landing-reveal mt-4 text-sm text-stone-400"
              style={{ animationDelay: "250ms" }}
            >
              Runs on Cloudflare&apos;s $5-a-month Workers Paid plan. We
              strongly recommend putting your Gateway behind{" "}
              <Link
                to="/docs/$"
                params={{ _splat: "access" }}
                className="text-stone-300 underline decoration-stone-600 underline-offset-4 transition-colors hover:text-white hover:decoration-stone-400"
              >
                Cloudflare Access
              </Link>
              : one command, free for up to 50 people.
            </p>

            <div
              className="landing-reveal mt-12"
              style={{ animationDelay: "300ms" }}
            >
              <p className="mb-3 text-sm text-stone-400">
                Hear about releases and breaking changes:
              </p>
              <WaitlistForm />
            </div>

            <div
              className="landing-reveal mt-16 flex flex-wrap items-center gap-4"
              style={{ animationDelay: "300ms" }}
            >
              <p className="text-sm text-stone-400">
                From the makers of{" "}
                <a
                  href="https://openseo.so"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-stone-300 underline decoration-stone-600 underline-offset-4 transition-colors hover:text-white hover:decoration-stone-400"
                >
                  openseo.so
                </a>
              </p>
              <a
                href={`https://github.com/${openSeoRepo}`}
                target="_blank"
                rel="noopener noreferrer"
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
      </div>
    </main>
  );
}
