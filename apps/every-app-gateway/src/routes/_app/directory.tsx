import { createFileRoute } from "@tanstack/react-router";
import { ArrowUpRight, Compass } from "lucide-react";
import { EmptyState } from "@/client/components/EmptyState";
import { Page, PageHeader } from "@/client/components/PageHeader";
import { Button } from "@/client/components/ui/button";

/**
 * The App directory: where people will list the apps they built and install
 * each other's on their own Gateway. Until it opens, the page points at the
 * repository on GitHub where people share their apps; the Gateway itself
 * sends nothing.
 */
const SHARED_APPS_URL = "https://github.com/every-app/awesome-every-app";

export const Route = createFileRoute("/_app/directory")({
  component: DirectoryPage,
});

function DirectoryPage() {
  return (
    <Page>
      <PageHeader title="App directory" />
      <EmptyState
        icon={Compass}
        size="lg"
        title="The directory opens soon"
        description="Install apps other people have built, and list your own."
        action={
          <Button
            nativeButton={false}
            render={
              <a href={SHARED_APPS_URL} target="_blank" rel="noreferrer" />
            }
          >
            List your app
            <ArrowUpRight data-icon="inline-end" />
          </Button>
        }
      />
    </Page>
  );
}
