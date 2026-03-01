import { createFileRoute } from "@tanstack/react-router";
import { HomeLayout } from "fumadocs-ui/layouts/home";
import { baseOptions } from "@/lib/layout.shared";

export const Route = createFileRoute("/privacy")({
  component: PrivacyPolicy,
  head: () => ({
    meta: [
      { title: "Privacy Policy — Every App" },
      {
        name: "description",
        content:
          "Privacy policy for Every App Gateway. We do not collect, store, or transmit any user data.",
      },
    ],
  }),
});

function PrivacyPolicy() {
  return (
    <HomeLayout {...baseOptions()}>
      <div className="max-w-3xl mx-auto px-6 py-12 md:py-24">
        <h1 className="text-4xl font-bold mb-2">Privacy Policy</h1>
        <p className="text-fd-muted-foreground mb-12">
          Effective date: February 24, 2026
        </p>

        <div className="space-y-10 text-[15px] leading-relaxed">
          <Section title="Overview">
            <p>
              Every App Gateway ("the App") is an open-source mobile client that
              connects to your own self-hosted Every App Gateway server. The App
              is developed by Ben Senescu ("we", "us", "our").
            </p>
            <p>
              We do not operate any servers that receive your data. All
              communication occurs directly between your device and the Gateway
              server you configure. We have no ability to access, collect, or
              view any of your information.
            </p>
          </Section>

          <Section title="Data We Collect">
            <p className="font-medium">None.</p>
            <p>
              We do not collect, transmit, or store any personal data, usage
              data, analytics, crash reports, or telemetry of any kind. There
              are no third-party analytics SDKs, advertising frameworks, or
              tracking tools embedded in the App.
            </p>
          </Section>

          <Section title="Data Stored on Your Device">
            <p>
              The App stores the following data locally on your device to
              function:
            </p>
            <ul className="list-disc pl-6 space-y-1.5">
              <li>
                <strong>Gateway URL</strong> — the address of your self-hosted
                server, stored in local storage.
              </li>
              <li>
                <strong>Authentication tokens</strong> — stored securely in the
                iOS Keychain via the system's secure storage APIs.
              </li>
            </ul>
            <p>
              This data never leaves your device except to communicate directly
              with the Gateway server you configured. We never receive, see, or
              have access to this data. You can delete all locally stored data
              at any time by uninstalling the App.
            </p>
          </Section>

          <Section title="Your Self-Hosted Server">
            <p>
              When you use the App, your credentials and app data are
              transmitted directly to the Gateway server you specify. That
              server is owned and operated by you. We have no access to, control
              over, or visibility into your server or the data it processes.
            </p>
            <p>
              The privacy practices of your self-hosted server are determined by
              your own configuration and deployment.
            </p>
          </Section>

          <Section title="Third-Party Services">
            <p>
              The App does not integrate with any third-party services,
              advertising networks, analytics platforms, or social media SDKs.
            </p>
          </Section>

          <Section title="Children's Privacy">
            <p>
              The App does not collect any data from anyone, including children
              under the age of 13.
            </p>
          </Section>

          <Section title="Changes to This Policy">
            <p>
              If we update this policy, we will post the revised version at this
              URL with a new effective date. Since we do not collect any contact
              information, this page is the sole means of notification.
            </p>
          </Section>

          <Section title="Contact">
            <p>
              If you have questions about this policy, you can reach us at{" "}
              <a
                href="mailto:ben@everyapp.dev"
                className="text-fd-primary hover:underline"
              >
                ben@everyapp.dev
              </a>{" "}
              or open an issue on{" "}
              <a
                href="https://github.com/every-app/every-app"
                target="_blank"
                rel="noopener noreferrer"
                className="text-fd-primary hover:underline"
              >
                GitHub
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
