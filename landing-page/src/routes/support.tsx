import { createFileRoute } from "@tanstack/react-router";
import { HomeLayout } from "fumadocs-ui/layouts/home";
import { baseOptions } from "@/lib/layout.shared";

export const Route = createFileRoute("/support")({
  component: Support,
  head: () => ({
    meta: [
      { title: "Support — Every App" },
      {
        name: "description",
        content:
          "Get help with Every App Gateway. Reach us by email or on Discord.",
      },
    ],
  }),
});

function Support() {
  return (
    <HomeLayout {...baseOptions()}>
      <div className="max-w-3xl mx-auto px-6 py-12 md:py-24">
        <h1 className="text-4xl font-bold mb-3">Support</h1>
        <p className="text-fd-muted-foreground mb-12">
          Need help with Every App Gateway? Here's how to reach us.
        </p>

        <div className="space-y-8">
          <div className="rounded-lg border p-6">
            <h2 className="text-xl font-semibold mb-2">Email</h2>
            <p className="text-fd-muted-foreground mb-4">
              Send us an email and we'll get back to you as soon as we can.
            </p>
            <a
              href="mailto:support@everyapp.dev"
              className="inline-flex items-center gap-2 text-fd-primary hover:underline font-medium"
            >
              support@everyapp.dev
            </a>
          </div>

          <div className="rounded-lg border p-6">
            <h2 className="text-xl font-semibold mb-2">Discord</h2>
            <p className="text-fd-muted-foreground mb-4">
              Join our Discord server to ask questions, report issues, or chat
              with the community.
            </p>
            <a
              href="https://discord.gg/c9uGs3cFXr"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 text-fd-primary hover:underline font-medium"
            >
              Join the Discord
            </a>
          </div>
        </div>
      </div>
    </HomeLayout>
  );
}
