import { createFileRoute } from "@tanstack/react-router";
import { AuthPageShell } from "@/client/components/auth/AuthPageShell";
import { ComposioForm } from "@/client/components/oauth/ComposioForm";
import {
  ConsentPageError,
  useConsentPage,
} from "@/client/components/oauth/consentPage";
import { PageLoading } from "@/client/components/Spinner";
import { COMPOSIO_PAGE } from "@/schemas/composio";
import { getComposioContext } from "@/serverFunctions/composio";

/**
 * The Composio page (docs/design/2026-11-composio.md): an app asks to use
 * an account from the signed-in person's Composio, for a provider this
 * Gateway holds no client for. /connect/<provider> checked the request and
 * started a one-use state (the `state` in this page's query). The page
 * shows what the person does next (ComposioForm): sign in to Composio,
 * connect a missing service there, or allow, whose native form posts to
 * /connect/<provider>/composio, which checks everything again. The first
 * two load the context again when they are done. A query without a state
 * fails the server's check, like any request that can't be shown.
 */
export const Route = createFileRoute("/oauth/composio")({
  component: ComposioPage,
});

const TITLE = "Can't connect this account";

function ComposioPage() {
  const { context, switchAccount, reload } = useConsentPage(
    COMPOSIO_PAGE,
    (query) =>
      getComposioContext({
        data: { state: new URLSearchParams(query).get("state") ?? "" },
      }),
  );
  if ("status" in context) {
    return context.status === "loading" ? (
      <PageLoading />
    ) : (
      <ConsentPageError title={TITLE} message="This request can't be shown." />
    );
  }
  if (!context.ok) {
    return <ConsentPageError title={TITLE} message={context.message} />;
  }
  return (
    <AuthPageShell>
      <main className="flex w-full justify-center">
        <ComposioForm
          context={context}
          onSwitchAccount={switchAccount}
          onReload={reload}
        />
      </main>
    </AuthPageShell>
  );
}
