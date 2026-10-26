import { createFileRoute, Link } from "@tanstack/react-router";
import { Check, Copy, Pause, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import setupPrompt from "../../content/docs/setup-prompt.txt?raw";
import { OG_IMAGE_PATH, toCanonicalUrl } from "@/lib/seo";
import { joinWaitlist } from "@/lib/waitlist.functions";

const homeTitle = "EveryApp: Make every app open source";
const homeDescription =
  "Own your tools. Customize your tools. Pay as you go. EveryApp puts the web apps you build online, in your own Cloudflare account. Open source, alpha.";
// What the Open Graph card says, so a screen reader hears the same words a sighted reader sees.
const ogImageAlt = "EveryApp. Make every app open source.";

const openSeoRepo = "every-app/open-seo";
// Hard-coded, not fetched: a GitHub API call per visit hits its rate limit. Update by hand.
const openSeoStars = "25k";

/**
 * The four apps, one line each, word for word the lines in the README and the
 * docs home (the orchestrating thread keeps them identical). Each links to
 * its page under /docs/apps.
 */
const apps: Array<{ name: string; line: string; href: string }> = [
  {
    name: "OpenSEO",
    line: "SEO research, rank tracking, site audits and AI visibility for your sites.",
    href: "/docs/apps/openseo",
  },
  {
    name: "OpenCRM",
    line: "Companies, contacts and deals, kept up to date by a research agent.",
    href: "/docs/apps/crm",
  },
  {
    name: "OpenAnalytics",
    line: "Web analytics for your sites. No cookies, no stored IP addresses.",
    href: "/docs/apps/analytics",
  },
  {
    name: "OpenMail",
    line: "A team inbox with an AI agent that reads, drafts and sends email on your domain.",
    href: "/docs/apps/openmail",
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

const features: Array<{ title: string; points: string[] }> = [
  {
    title: "Secure by default",
    points: [
      "Every request passes through the Gateway. Apps have no public address.",
      "Connect an API once. Apps ask for access, and the Gateway makes the call, so no app ever holds your keys.",
      "Secured behind Cloudflare Access.",
    ],
  },
  {
    title: "Scales from zero to infinity",
    points: [
      "Fully serverless, in your own Cloudflare account.",
      "An app nobody uses costs $0.",
      "$5/month for Cloudflare's Workers Paid plan hosts hundreds of apps.",
    ],
  },
  {
    title: "Standardized",
    points: [
      "No infra decisions. Every app runs on Cloudflare's building blocks: Workers, D1, R2 and KV.",
      "Your agent builds with our stack and component library, so it never has to invent patterns.",
    ],
  },
];

type CopyStatus = "idle" | "copied" | "error";

function CopySetupPrompt() {
  const [status, setStatus] = useState<CopyStatus>("idle");

  useEffect(() => {
    if (status === "idle") return;
    const timer = setTimeout(() => setStatus("idle"), 2500);
    return () => clearTimeout(timer);
  }, [status]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(setupPrompt);
      setStatus("copied");
    } catch {
      setStatus("error");
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      className="inline-flex h-14 items-center gap-3 rounded-md bg-stone-100 px-7 text-base font-medium text-[#0a0f0d] transition-colors hover:bg-white"
    >
      {status === "copied" ? (
        <Check className="h-5 w-5" aria-hidden="true" />
      ) : (
        <Copy className="h-5 w-5" aria-hidden="true" />
      )}
      <span aria-live="polite">
        {status === "copied"
          ? "Paste into your favorite agent"
          : status === "error"
            ? "Copy failed, see the docs"
            : "Copy the setup prompt"}
      </span>
    </button>
  );
}

/**
 * The two demo loops share one restrained frame: a soft dark surface with a
 * hairline outline, the media clipped to the inner corners, 16:9 reserved so
 * nothing shifts while the video loads. The MP4 is tagged sRGB so the dark
 * surfaces match the page; the poster is the first frame of the loop.
 * Reduced motion shows the poster and does not autoplay; the pause/play
 * control works either way.
 */
function DemoAnimation({
  name,
  alt,
  className = "",
}: {
  name: "apps-demo" | "gateway-demo";
  alt: string;
  className?: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (reduced.matches) return;
    // Autoplay is requested after hydration so a reduced-motion reader never
    // sees the loop start; the poster stays until the video is ready.
    video.play().catch(() => {});
  }, []);

  const toggle = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  };

  return (
    <figure
      className={`w-full rounded-[12px] border border-white/[0.12] bg-stone-950/70 p-1.5 shadow-[0_24px_64px_-24px_rgba(0,0,0,0.8)] md:rounded-2xl md:p-2 ${className}`}
    >
      <div className="relative aspect-video w-full overflow-hidden rounded-[6px] bg-[#252522] md:rounded-[8px]">
        <video
          ref={videoRef}
          className="block h-full w-full"
          width={2304}
          height={1296}
          poster={`/media/${name}-poster.webp`}
          loop
          muted
          playsInline
          preload="metadata"
          aria-label={alt}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
        >
          <source src={`/media/${name}.mp4`} type="video/mp4" />
          <source src={`/media/${name}.webm`} type="video/webm" />
        </video>
        <button
          type="button"
          onClick={toggle}
          aria-label={playing ? "Pause animation" : "Play animation"}
          className="absolute right-2 bottom-2 flex h-8 w-8 items-center justify-center rounded-full border border-white/[0.15] bg-black/55 text-stone-200 backdrop-blur transition-colors hover:bg-black/75 focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:outline-none md:right-3 md:bottom-3"
        >
          {playing ? (
            <Pause className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <Play className="h-3.5 w-3.5" aria-hidden="true" />
          )}
        </button>
      </div>
    </figure>
  );
}

function Home() {
  return (
    <div className="relative min-h-screen bg-[#0a0f0d] text-stone-100">
      <header className="absolute top-0 left-0 right-0 px-6 py-6">
        <div className="mx-auto flex max-w-6xl items-center justify-between">
          <img
            src="/transparent-logo-256.png"
            alt="EveryApp logo"
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
        {/* Leave room for the large app preview to enter the first screen. */}
        <div className="flex min-h-[75svh] items-center px-6 pt-28 pb-12">
          <div className="mx-auto w-full max-w-6xl">
            <h1 className="landing-reveal mb-6 max-w-4xl text-balance text-[clamp(2.75rem,7vw,5.25rem)] font-semibold leading-[1.08] tracking-[-0.015em] text-white">
              Make every app open source
            </h1>
            <p
              className="landing-reveal mb-10 max-w-2xl text-balance text-[clamp(1.125rem,2vw,1.5rem)] leading-snug text-stone-300"
              style={{ animationDelay: "50ms" }}
            >
              One platform for every tool you and your agent need to grow your
              business.
            </p>
            <div className="landing-reveal" style={{ animationDelay: "100ms" }}>
              <CopySetupPrompt />
              <p className="mt-4 text-sm text-stone-400">
                Or,{" "}
                <Link
                  to="/docs/$"
                  params={{ _splat: "gateway" }}
                  className={linkClass}
                >
                  set up manually
                </Link>
                .
              </p>
              {/* Social proof, right under the call to action. */}
              <div className="mt-12 flex flex-wrap items-center gap-4">
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
                  aria-label={`OpenSEO on GitHub, ${openSeoStars} stars`}
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
                  <span
                    className="h-3.5 w-px bg-stone-800"
                    aria-hidden="true"
                  />
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
                  <span className="font-mono tabular-nums">{openSeoStars}</span>
                </a>
              </div>
            </div>
          </div>
        </div>

        <div id="app-demo" className="px-6 pb-16">
          <div className="mx-auto w-full max-w-6xl">
            <DemoAnimation
              name="apps-demo"
              alt="Tour of the EveryApp app launcher, opening OpenSEO keyword research."
            />
          </div>
        </div>

        <section
          id="apps"
          aria-labelledby="apps-title"
          className="border-t border-stone-900 px-6 py-16"
        >
          <div className="mx-auto w-full max-w-6xl">
            <div className="max-w-2xl">
              <h2
                id="apps-title"
                className="mb-6 text-2xl font-semibold tracking-tight text-white"
              >
                Apps
              </h2>
              <ul className="mb-6 space-y-3 text-base text-stone-300">
                {apps.map((app) => (
                  <li key={app.name}>
                    <a
                      href={app.href}
                      className="font-medium text-white underline decoration-stone-600 underline-offset-4 transition-colors hover:decoration-stone-400"
                    >
                      {app.name}
                    </a>
                    <span className="text-stone-500">: </span>
                    {app.line}
                  </li>
                ))}
              </ul>
              <p className="text-base text-stone-400">
                Run one as it is, or fork it as the starting point for your own.
                Many more are coming.{" "}
                <a
                  href="/docs/apps"
                  className="font-medium text-white underline decoration-stone-600 underline-offset-4 transition-colors hover:decoration-stone-400"
                >
                  See all apps
                </a>
              </p>
            </div>
          </div>
        </section>

        <section
          id="why"
          aria-labelledby="why-title"
          className="border-t border-stone-900 px-6 py-16"
        >
          <div className="mx-auto grid w-full max-w-6xl items-center gap-10 lg:grid-cols-2 lg:gap-16">
            <div className="min-w-0">
              <h2
                id="why-title"
                className="mb-10 text-2xl font-semibold tracking-tight text-white"
              >
                Why use EveryApp?
              </h2>
              <div className="grid gap-8">
                {features.map((feature) => (
                  <div key={feature.title}>
                    <h3 className="mb-4 text-lg font-medium text-white">
                      {feature.title}
                    </h3>
                    <ul className="space-y-3 text-base text-stone-400">
                      {feature.points.map((point) => (
                        <li key={point}>{point}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
            <DemoAnimation
              name="gateway-demo"
              alt="Your team and agent connect through one secure Gateway to private apps and connected MCP tools."
            />
          </div>
        </section>
      </main>

      <footer className="border-t border-stone-900 px-6 py-16">
        <div className="mx-auto w-full max-w-6xl">
          <div className="max-w-2xl">
            <p className="mb-3 text-sm text-stone-400">
              Get updates about EveryApp
            </p>
            <WaitlistForm />

            <div className="mt-16">
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
