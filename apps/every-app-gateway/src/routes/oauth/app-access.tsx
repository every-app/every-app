import { createFileRoute } from "@tanstack/react-router";
import { AuthPageShell } from "@/client/components/auth/AuthPageShell";
import { AppAccessForm } from "@/client/components/oauth/AppAccessForm";
import {
  ConsentPageError,
  useConsentPage,
} from "@/client/components/oauth/consentPage";
import { PageLoading } from "@/client/components/Spinner";
import { ALLOW_PAGE } from "@/schemas/app-access";
import { getAppAccessContext } from "@/serverFunctions/appAccessConsent";

/**
 * The Allow page (docs/design/2026-11-oauth-one-connection.md): an app asks
 * to use the signed-in person's connection to a provider. It only displays:
 * /connect/<provider> checked the request and started a one-use state (the
 * `state` in this page's query), and the native form (AppAccessForm) posts
 * the person's decision to /connect/<provider>/allow, which checks it
 * again. A query without a state fails the server's check, like any
 * request that can't be shown.
 */
export const Route = createFileRoute("/oauth/app-access")({
  component: AppAccessPage,
});

const TITLE = "Can't allow this app";

function AppAccessPage() {
  const { context, switchAccount } = useConsentPage(ALLOW_PAGE, (query) =>
    getAppAccessContext({
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
        <AppAccessForm context={context} onSwitchAccount={switchAccount} />
      </main>
    </AuthPageShell>
  );
}
