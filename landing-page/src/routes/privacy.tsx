import { createFileRoute } from "@tanstack/react-router";
import { HomeLayout } from "fumadocs-ui/layouts/home";
import { homeOptions } from "@/lib/layout.shared";
import { buildPageSeo } from "@/lib/seo";

export const Route = createFileRoute("/privacy")({
  component: PrivacyPolicy,
  head: () =>
    buildPageSeo({
      title: "Privacy",
      titleSuffix: "EveryApp",
      path: "/privacy",
      description:
        "What everyapp.com collects: self-hosted page view analytics and the email addresses people leave to hear about releases. And the short daily usage report a Gateway sends us.",
    }),
});

function PrivacyPolicy() {
  return (
    <HomeLayout {...homeOptions()}>
      <div className="max-w-3xl mx-auto px-6 py-12 md:py-24">
        <h1 className="text-4xl font-bold mb-2">Privacy</h1>
        <p className="text-fd-muted-foreground mb-12">
          Effective date: November 16, 2026
        </p>

        <div className="space-y-10 text-[15px] leading-relaxed">
          <Section title="Analytics">
            <p>
              This site loads its own analytics script from
              analytics.everyapp.team: our own OpenAnalytics, running behind our
              own Gateway at everyapp.team. It records page views without
              cookies; nothing is shared with a third-party tracker or ad
              network.
            </p>
          </Section>

          <Section title="Hear about releases">
            <p>
              If you leave your email address in the "Keep me posted" form on
              the home page, it goes to our mailing list at Loops (loops.so) and
              we use it only to tell you about releases and breaking changes.
              Every email has an unsubscribe link, or email support@everyapp.dev
              to have it removed.
            </p>
          </Section>

          <Section title="Cookies">
            <p>
              The site sets no cookies for tracking. The docs remember your
              light or dark theme choice in your browser's local storage.
            </p>
          </Section>

          <Section title="Your Gateway">
            <p>
              EveryApp itself runs in your own Cloudflare account. The data your
              Gateway and apps hold stays with you.
            </p>
          </Section>

          <Section title="Usage reports from Gateways">
            <p>
              Once a day, a self-hosted Gateway sends us a short usage report: a
              random ID, its version, the month it was set up, and rounded
              counts of members, active members, apps, and use per app. It holds
              no domain, name, email, or anything inside an app, and apps you
              built are never named. We use it to know how many Gateways are
              running and how many people use them.
            </p>
            <p>
              Reports go to our own receiver on Cloudflare, which already runs
              your Gateway; no other company receives them. We keep them for 25
              months. An owner or admin can read the exact report and turn
              reports off under Manage workspace, or with{" "}
              <code>everyapp telemetry off</code>.{" "}
              <a
                href="/docs/telemetry"
                className="text-fd-primary hover:underline"
              >
                What a report holds
              </a>
              .
            </p>
          </Section>

          <Section title="Contact">
            <p>
              Questions about this policy go to{" "}
              <a
                href="mailto:support@everyapp.dev"
                className="text-fd-primary hover:underline"
              >
                support@everyapp.dev
              </a>
              .
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
