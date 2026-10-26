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
        "What everyapp.com collects: self-hosted page view analytics and the email addresses people leave to hear about releases.",
    }),
});

function PrivacyPolicy() {
  return (
    <HomeLayout {...homeOptions()}>
      <div className="max-w-3xl mx-auto px-6 py-12 md:py-24">
        <h1 className="text-4xl font-bold mb-2">Privacy</h1>
        <p className="text-fd-muted-foreground mb-12">
          Effective date: October 24, 2026
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
              EveryApp itself runs in your own Cloudflare account. This page is
              about everyapp.com only; the data your Gateway and apps hold stays
              with you.
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
              </a>{" "}
              (everyapp.dev is ours too; it redirects to this site). Expect a
              fast, informal reply from a very small team. If we change it, the
              new version appears here with a new effective date.
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
