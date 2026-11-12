import { createFileRoute } from "@tanstack/react-router";
import { AuthPageShell } from "@/client/components/auth/AuthPageShell";
import { ConsentForm } from "@/client/components/oauth/ConsentForm";
import {
  ConsentPageError,
  useConsentPage,
} from "@/client/components/oauth/consentPage";
import {
  isNativeConsent,
  NativeConsentForm,
} from "@/client/components/oauth/NativeConsentForm";
import { PageLoading } from "@/client/components/Spinner";
import { getConsentContext } from "@/serverFunctions/oauthConsent";

/**
 * The consent page for an AI app connecting to the gateway's /mcp, or, when
 * the request's resource is an app's host, for a native app signing in to
 * that one app (docs/design/native-sign-in.md section 6). It only displays: /oauth/authorize validated the request and started a one-time
 * consent transaction (the `handle`, bound to this browser), and the native
 * form (ConsentForm) posts the user's choices to /oauth/consent/decision,
 * which checks them again.
 */
export const Route = createFileRoute("/oauth/consent")({
  component: ConsentPage,
});

/**
 * Whether the request names an app host as its resource (a native app
 * signing in), read from the page's own query: a refusal carries no grant.
 */
function asksForAppHost(query: string): boolean {
  const resource = new URLSearchParams(query).get("resource");
  return Boolean(resource) && !resource!.endsWith("/mcp");
}

function ConsentPage() {
  const { query, context, switchAccount } = useConsentPage(
    "/oauth/consent",
    (query) => getConsentContext({ data: { query } }),
  );
  const title = asksForAppHost(query)
    ? "Can't sign in"
    : "Can't connect this app";
  if ("status" in context) {
    return context.status === "loading" ? (
      <PageLoading />
    ) : (
      <ConsentPageError
        title={title}
        message="This connection request can't be shown."
      />
    );
  }
  if (!context.ok) {
    return <ConsentPageError title={title} message={context.message} />;
  }
  return (
    <AuthPageShell>
      <main className="flex w-full justify-center">
        {isNativeConsent(context) ? (
          <NativeConsentForm
            context={context}
            onSwitchAccount={switchAccount}
          />
        ) : (
          <ConsentForm context={context} onSwitchAccount={switchAccount} />
        )}
      </main>
    </AuthPageShell>
  );
}
