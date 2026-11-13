import { createFileRoute, Link } from "@tanstack/react-router";
import { HomeLayout } from "fumadocs-ui/layouts/home";
import { homeOptions } from "@/lib/layout.shared";
import { buildPageSeo } from "@/lib/seo";

export const Route = createFileRoute("/pricing")({
  component: Pricing,
  head: () =>
    buildPageSeo({
      title: "Pricing",
      titleSuffix: "EveryApp",
      path: "/pricing",
      description:
        "EveryApp is free and open source. You pay Cloudflare, from $5 a month, and the services you connect.",
    }),
});

// The same rows as "What it costs" on /docs/how-it-works. Change both together.
const COSTS: Array<[what: string, cost: string]> = [
  ["EveryApp", "Free and open source"],
  ["Cloudflare's Workers Paid plan", "$5 a month, then usage"],
  ["A .com domain", "About $10 a year"],
  ["A .dev or .app domain", "$1 for the first year"],
  [
    "An AI key, for apps that use AI",
    "Billed by use by OpenAI or OpenRouter, or Workers AI",
  ],
  ["A DataForSEO key, for OpenSEO", "Pay as you go, billed by DataForSEO"],
];

function Pricing() {
  return (
    <HomeLayout {...homeOptions()}>
      <div className="max-w-3xl mx-auto px-6 py-12 md:py-24">
        <h1 className="text-4xl font-bold mb-2">Pricing</h1>
        <p className="text-fd-muted-foreground mb-12">
          EveryApp is free and open source. It runs in your own Cloudflare
          account, so you pay Cloudflare and the services you connect.
        </p>

        <div className="space-y-10 text-[15px] leading-relaxed">
          <Section title="What it costs">
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-fd-border text-fd-foreground">
                    <th className="py-2 pr-6 font-medium">What</th>
                    <th className="py-2 font-medium">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {COSTS.map(([what, cost]) => (
                    <tr key={what} className="border-b border-fd-border">
                      <td className="py-2 pr-6 text-fd-foreground">{what}</td>
                      <td className="py-2">{cost}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section title="What the $5 covers">
            <p>
              The $5 covers 10 million requests a month, far more than a few
              apps for a small team use. Past that, Cloudflare bills by use (
              <a
                href="https://developers.cloudflare.com/workers/platform/pricing/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-fd-primary hover:underline"
              >
                pricing
              </a>
              ).
            </p>
            <p>
              An app nobody uses costs $0. You pay for what you use, not per
              seat.
            </p>
          </Section>

          <Section title="Cap what your apps spend">
            <p>
              You can cap what your apps spend on AI and other keys, in dollars
              per month.{" "}
              <Link
                to="/docs/$"
                params={{ _splat: "usage" }}
                className="text-fd-primary hover:underline"
              >
                Usage and caps
              </Link>
            </p>
          </Section>

          <Section title="More">
            <p>
              <Link
                to="/docs/$"
                params={{ _splat: "how-it-works" }}
                className="text-fd-primary hover:underline"
              >
                How it works
              </Link>{" "}
              covers where your apps run and how they stay private.
            </p>
          </Section>
        </div>
      </div>
    </HomeLayout>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="text-xl font-semibold mb-3">{title}</h2>
      <div className="space-y-3 text-fd-muted-foreground">{children}</div>
    </section>
  );
}
