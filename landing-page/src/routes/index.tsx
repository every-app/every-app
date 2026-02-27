import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import "plyr/dist/plyr.css";
import { toCanonicalUrl } from "@/lib/seo";

const homeTitle = "Every App - Make every app open source";
const homeDescription =
  "Make every app open source. Build what you want to exist. Share it easily with others. Self host unlimited apps on Cloudflare for $5/month.";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: homeTitle },
      { name: "description", content: homeDescription },
      { property: "og:type", content: "website" },
      { property: "og:title", content: homeTitle },
      { property: "og:description", content: homeDescription },
      { property: "og:url", content: toCanonicalUrl("/") },
      { property: "og:image", content: "/OpenGraphPreview.png" },
      { property: "og:image:alt", content: homeTitle },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: homeTitle },
      { name: "twitter:description", content: homeDescription },
      { name: "twitter:image", content: "/OpenGraphPreview.png" },
      { name: "twitter:image:alt", content: homeTitle },
    ],
    links: [{ rel: "canonical", href: toCanonicalUrl("/") }],
  }),
  component: Home,
});

const videoManifestUrl =
  "https://customer-30n86idll8ihv3ko.cloudflarestream.com/2382a24aad763613e4072c789e743759/manifest/video.m3u8";

const demoTimestamps = [
  { label: "App Demos", time: "0:11", seconds: 11 },
  { label: "Why Every App Exists", time: "0:40", seconds: 40 },
  { label: "Self Host w/ 1 Command", time: "1:21", seconds: 81 },
  { label: "Walkthrough: Workout Tracker", time: "2:37", seconds: 157 },
  { label: "Gateway Architecture", time: "3:36", seconds: 216 },
  { label: "Build an App", time: "5:46", seconds: 346 },
];

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  return (
    <button
      onClick={handleCopy}
      className="text-stone-400 hover:text-stone-200 transition-colors"
      aria-label="Copy command"
    >
      {copied ? (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
          <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
        </svg>
      )}
    </button>
  );
}

function DemoVideo() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  const enableCaptions = (video: HTMLVideoElement) => {
    const tracks = Array.from(video.textTracks);
    if (!tracks.length) return false;

    const preferred =
      tracks.find(
        (track) =>
          track.language?.toLowerCase().startsWith("en") ||
          track.label?.toLowerCase().includes("english"),
      ) ?? tracks[0];

    for (const track of tracks) {
      track.mode = track === preferred ? "showing" : "disabled";
    }

    return true;
  };

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let active = true;
    let player: {
      destroy: () => void;
      on: any;
      off: any;
      captions?: any;
    } | null = null;

    const markLoaded = () => {
      if (!active) return;
      setIsLoaded(true);
      enableCaptions(video);
    };

    const setup = async () => {
      const { default: Plyr } = await import("plyr");
      if (!active) return;

      player = new Plyr(video, {
        controls: [
          "play-large",
          "play",
          "progress",
          "current-time",
          "mute",
          "volume",
          "captions",
          "fullscreen",
        ],
        captions: { active: false, language: "auto", update: true },
      });

      const enableCaptionsOnFirstPlay = () => {
        let attempts = 0;
        const maxAttempts = 12;

        const tryEnable = () => {
          const ok = enableCaptions(video);
          if (ok && player?.captions) {
            player.captions.active = true;
          }
          return ok;
        };

        const intervalId = window.setInterval(() => {
          attempts += 1;
          if (tryEnable() || attempts >= maxAttempts) {
            window.clearInterval(intervalId);
          }
        }, 500);

        if (tryEnable()) {
          window.clearInterval(intervalId);
        }

        player?.off("play", enableCaptionsOnFirstPlay);
      };

      player.on("play", enableCaptionsOnFirstPlay);

      if (Hls.isSupported()) {
        const hls = new Hls();

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          const highestLevel = Math.max(0, hls.levels.length - 1);
          hls.startLevel = highestLevel;
          hls.nextLevel = highestLevel;
        });

        hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => {
          if (hls.subtitleTracks.length === 0) return;
          const idx = hls.subtitleTracks.findIndex((track) =>
            (track.lang ?? "").toLowerCase().startsWith("en"),
          );
          hls.subtitleTrack = idx >= 0 ? idx : 0;
          hls.subtitleDisplay = true;
        });

        hls.loadSource(videoManifestUrl);
        hls.attachMedia(video);
        hlsRef.current = hls;
      } else {
        video.src = videoManifestUrl;
      }

      if (video.readyState >= 1) {
        markLoaded();
      } else {
        video.addEventListener("loadedmetadata", markLoaded, { once: true });
        video.addEventListener("canplay", markLoaded, { once: true });
      }
    };

    void setup();

    return () => {
      active = false;
      hlsRef.current?.destroy();
      hlsRef.current = null;
      player?.destroy();
    };
  }, []);

  return (
    <div className={`demo-player-frame ${isLoaded ? "is-loaded" : ""}`}>
      <div className="demo-player-skeleton" aria-hidden="true" />
      <video
        id="everyapp-demo-player"
        ref={videoRef}
        className="demo-player-video block w-full h-auto"
        playsInline
        controls
        preload="metadata"
        onPlay={() => {
          const video = videoRef.current;
          if (!video) return;

          enableCaptions(video);
        }}
      />
      <div className="demo-player-chapters" aria-label="Video timestamps">
        {demoTimestamps.map((entry) => (
          <button
            key={entry.label}
            className="demo-chapter-button"
            type="button"
            title={`${entry.time} - ${entry.label}`}
            onClick={() => {
              const video = videoRef.current;
              if (!video) return;
              video.currentTime = entry.seconds;
              void video.play();
            }}
          >
            <span className="demo-chapter-time">{entry.time}</span>
            <span className="demo-chapter-label">{entry.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function FeatureCard({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="bg-[#141a17] border border-stone-800 rounded-lg p-6">
      <h3 className="text-white font-semibold text-lg mb-2">{title}</h3>
      <p className="text-stone-400 text-sm">{description}</p>
    </div>
  );
}

function AppCard({
  title,
  description,
  cardImage,
  previewImage,
  onPreview,
}: {
  title: string;
  description: string;
  cardImage: string;
  previewImage: string;
  onPreview: (img: string, alt: string) => void;
}) {
  return (
    <button
      className="bg-[#141a17] border border-stone-800 rounded-lg overflow-hidden text-left cursor-pointer hover:border-stone-700 transition-colors"
      onClick={() => onPreview(previewImage, `${title} Screenshot`)}
    >
      <div className="aspect-video bg-stone-900 flex items-center justify-center">
        <img
          src={cardImage}
          alt={`${title} Screenshot`}
          className="w-full h-full object-contain"
          loading="lazy"
          decoding="async"
        />
      </div>
      <div className="p-6">
        <h3 className="text-white font-semibold text-lg mb-2">{title}</h3>
        <p className="text-stone-400 text-sm">{description}</p>
      </div>
    </button>
  );
}

function Home() {
  const [preview, setPreview] = useState<{ src: string; alt: string } | null>(
    null,
  );

  return (
    <main className="bg-[#0a0f0d] text-stone-100 min-h-screen">
      <header className="absolute top-0 left-0 right-0 z-10 px-6 py-6">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <img
            src="/transparent-logo-256.png"
            alt="Every App Logo"
            className="w-12 h-12 opacity-80 hover:opacity-100 transition-opacity"
            width={48}
            height={48}
          />
          <nav className="flex items-center gap-6">
            <Link
              to="/docs/$"
              params={{ _splat: "introduction" }}
              className="text-white text-base font-medium hover:text-stone-300 transition-colors"
            >
              Docs
            </Link>
            <a
              href="https://discord.gg/c9uGs3cFXr"
              target="_blank"
              rel="noopener noreferrer"
              className="text-stone-300 hover:text-white transition-colors text-sm"
            >
              Discord
            </a>
            <a
              href="https://github.com/every-app/every-app"
              target="_blank"
              rel="noopener noreferrer"
              className="text-stone-300 hover:text-white transition-colors text-sm"
            >
              GitHub
            </a>
          </nav>
        </div>
      </header>

      <section className="relative px-6 pt-[10svh] md:pt-[8svh] pb-16 md:pb-20">
        <div className="max-w-6xl mx-auto">
          <div className="min-h-[72svh] md:min-h-[76svh] flex items-center">
            <div className="max-w-2xl">
              <h1 className="text-[clamp(3rem,10vw,7rem)] font-bold text-white leading-none tracking-tight mb-6">
                EVERY APP
              </h1>
              <p className="text-[clamp(1.5rem,3vw,2rem)] text-white font-normal mb-6">
                Make every app open source
              </p>
              <div className="space-y-2 text-[clamp(1rem,2vw,1.25rem)] text-stone-400 font-light mb-10">
                <p>Build what you want to exist</p>
                <p>Share it easily with others</p>
                <p>Self host unlimited apps on Cloudflare for $5/month</p>
              </div>

              <p className="text-stone-400 text-sm mb-2">
                Self host with one command
              </p>
              <div className="bg-[#141a17] border border-stone-800 rounded-md px-3 py-2 inline-flex items-center gap-3">
                <code className="text-sm text-stone-300 font-mono">
                  npx everyapp gateway deploy
                </code>
                <CopyButton text="npx everyapp gateway deploy" />
              </div>
            </div>
          </div>

          <div className="mt-4 md:mt-6 rounded-2xl border border-stone-800 overflow-hidden bg-[#090e0c]">
            <DemoVideo />
          </div>
        </div>
      </section>

      <div className="px-16">
        <hr className="border-stone-800" />
      </div>

      <section className="px-6 py-12 md:py-24">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-[clamp(2rem,5vw,3rem)] font-bold text-white mb-4">
            What is Every App?
          </h2>
          <div className="text-stone-400 text-lg max-w-3xl space-y-4">
            <p>
              Every App is a platform for self hosting apps. It standardizes how
              to build them on Cloudflare so that your apps scale to zero and
              also to infinity.
            </p>
            <p>
              It hoists common logic like authentication and user management to
              the Every App Gateway so that you don&apos;t need to triple check
              if your AI agent screwed that up.
            </p>
            <p>
              Every App&apos;s goal is to kickstart a community that builds
              thousands of fun and powerful applications that are just as easy
              to use as any traditional consumer app or SaaS.
            </p>
          </div>
        </div>
      </section>

      <div className="px-16">
        <hr className="border-stone-800" />
      </div>

      <section className="px-6 py-12 md:py-24">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-[clamp(2rem,5vw,3rem)] font-bold text-white mb-4">
            Stop rebuilding the same stuff
          </h2>
          <p className="text-stone-400 text-lg mb-12 max-w-3xl">
            Every App handles the tedious parts of building new apps so you can
            focus on your idea.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            <FeatureCard
              title="Authentication"
              description="Users log in once to the Gateway. Your apps inherit auth automatically."
            />
            <FeatureCard
              title="User Management"
              description="Add users to your Gateway. They instantly get access to all your apps."
            />
            <FeatureCard
              title="Database Setup"
              description="Cloudflare D1 pre-configured. Just define your schema and go."
            />
            <FeatureCard
              title="Hosting & Deployment"
              description="One CLI command deploys to Cloudflare. Scales to zero, starts free."
            />
            <FeatureCard
              title="Agent First"
              description="MCP server gives your coding agent full example apps to reference."
            />
            <FeatureCard
              title="Patterns That Scale"
              description="Well-defined patterns for your agent to follow."
            />
          </div>
        </div>
      </section>

      <div className="px-16">
        <hr className="border-stone-800" />
      </div>

      <section className="px-6 py-12 md:py-24">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-[clamp(2rem,5vw,3rem)] font-bold text-white mb-4">
            One place for all your apps
          </h2>
          <p className="text-stone-400 text-lg mb-12 max-w-3xl">
            The Gateway is your personal app hub. Manage and access everything
            from a single URL.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <FeatureCard
              title="Single URL"
              description="Go to your Gateway. Access all your apps."
            />
            <FeatureCard
              title="Mobile Optimized"
              description="Add Gateway to your home screen once. All apps get the mobile PWA benefits. Native mobile (and Roku) apps coming soon."
            />
            <FeatureCard
              title="Simplified Auth"
              description="Apps inherit authentication from the Gateway. Deploy new apps faster than it takes to Login with Google."
            />
            <FeatureCard
              title="LLM Gateway (Coming Soon)"
              description="Configure your AI provider once. Set per-app budgets. No more scattered API keys."
            />
          </div>
        </div>
      </section>

      <div className="px-16">
        <hr className="border-stone-800" />
      </div>

      <section className="px-6 py-12 md:py-24">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-[clamp(2rem,5vw,3rem)] font-bold text-white mb-4">
            App Examples
          </h2>
          <p className="text-stone-400 text-lg mb-12 max-w-2xl">
            Deploy these open source apps with one command. Tell your agent to
            reference their code with our MCP.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <AppCard
              title="Todo App"
              description="A minimal todo list with sync across your devices and keyboard navigation."
              cardImage="/screenshots/todo-dark-thumb.png"
              previewImage="/screenshots/todo-dark.png"
              onPreview={(src, alt) => setPreview({ src, alt })}
            />
            <AppCard
              title="Workout Tracker"
              description="Mobile optimized. Track your workouts, programs, and progress over time."
              cardImage="/screenshots/workout-tracker-dark-thumb.png"
              previewImage="/screenshots/workout-tracker-dark.png"
              onPreview={(src, alt) => setPreview({ src, alt })}
            />
            <AppCard
              title="Cooking Assistant"
              description="An AI-powered cooking assistant and recipe manager."
              cardImage="/screenshots/chef-dark-thumb.png"
              previewImage="/screenshots/chef-dark.png"
              onPreview={(src, alt) => setPreview({ src, alt })}
            />
          </div>
        </div>
      </section>

      <div className="px-16">
        <hr className="border-stone-800" />
      </div>

      <section className="px-6 py-12 md:py-24">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-[clamp(2rem,5vw,3rem)] font-bold text-white mb-4">
            Get Started
          </h2>
          <p className="text-stone-400 text-lg mb-8">
            Deploy your own Gateway to Cloudflare in one command.
          </p>
          <div className="bg-[#141a17] border border-stone-800 rounded-md px-3 py-2 mb-6 inline-flex items-center gap-3">
            <code className="text-sm text-stone-300 font-mono">
              npx everyapp gateway deploy
            </code>
            <CopyButton text="npx everyapp gateway deploy" />
          </div>
          <div>
            <Link
              to="/docs/$"
              params={{ _splat: "introduction" }}
              className="inline-flex items-center gap-2 text-stone-400 hover:text-white transition-colors underline underline-offset-4 decoration-stone-600 hover:decoration-stone-400"
            >
              Read the Docs
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M5 12h14M12 5l7 7-7 7" />
              </svg>
            </Link>
          </div>
        </div>
      </section>

      <footer className="px-6 py-12 border-t border-stone-800">
        <div className="max-w-5xl mx-auto flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
          <div className="hidden md:flex items-center gap-3">
            <img
              src="/transparent-logo-256.png"
              alt="Every App Logo"
              className="w-8 h-8 opacity-60"
              width={32}
              height={32}
            />
            <span className="text-stone-400 text-sm">
              Make every app open source
            </span>
          </div>
          <div className="flex items-center gap-6 self-end md:self-auto">
            <a
              href="https://discord.gg/c9uGs3cFXr"
              target="_blank"
              rel="noopener noreferrer"
              className="text-stone-400 hover:text-white transition-colors text-sm"
            >
              Discord
            </a>
            <a
              href="https://github.com/every-app/every-app"
              target="_blank"
              rel="noopener noreferrer"
              className="text-stone-400 hover:text-white transition-colors text-sm"
            >
              GitHub
            </a>
            <Link
              to="/docs/$"
              params={{ _splat: "introduction" }}
              className="text-stone-400 hover:text-white transition-colors text-sm"
            >
              Docs
            </Link>
          </div>
        </div>
      </footer>

      {preview ? (
        <button
          type="button"
          className="fixed inset-0 z-50 bg-black/70 p-4 md:p-12 cursor-zoom-out"
          onClick={() => setPreview(null)}
          aria-label="Close screenshot preview"
        >
          <img
            src={preview.src}
            alt={preview.alt}
            className="w-full h-full object-contain rounded-lg"
          />
        </button>
      ) : null}
    </main>
  );
}
