import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { CircleAlert } from "lucide-react";
import { signOutAndForget } from "@/client/sign-out";
import { AuthPageShell } from "@/client/components/auth/AuthPageShell";
import { ConsentForm } from "@/client/components/oauth/ConsentForm";
import {
  isNativeConsent,
  NativeConsentForm,
} from "@/client/components/oauth/NativeConsentForm";
import { PageLoading } from "@/client/components/Spinner";
import { StatusScreen } from "@/client/components/StatusScreen";
import { Alert, AlertDescription } from "@/client/components/ui/alert";
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

function currentQuery(): string {
  return typeof window === "undefined" ? "" : window.location.search;
}

type ConsentResult = Awaited<ReturnType<typeof getConsentContext>>;

/**
 * Whether the request names an app host as its resource (a native app
 * signing in), read from the page's own query: a refusal carries no grant.
 */
function asksForAppHost(query: string): boolean {
  const resource = new URLSearchParams(query).get("resource");
  return Boolean(resource) && !resource!.endsWith("/mcp");
}

/** Sign in, then come back to this same consent page. */
function signInAndReturn(query: string): void {
  window.location.assign(
    `/sign-in?redirect=${encodeURIComponent(`/oauth/consent${query}`)}`,
  );
}

async function switchAccount(query: string): Promise<void> {
  await signOutAndForget();
  signInAndReturn(query);
}

/**
 * Loaded once, outside the persisted query cache: the context holds the
 * consent handle, which has no business in localStorage. A signed-out
 * visitor is sent to sign in and back.
 */
function useConsentContext(query: string) {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "failed" }
    | Exclude<ConsentResult, { signedOut: true }>
  >({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    getConsentContext({ data: { query } }).then(
      (context) => {
        if (cancelled) return;
        if ("signedOut" in context) signInAndReturn(query);
        else setState(context);
      },
      () => !cancelled && setState({ status: "failed" }),
    );
    return () => {
      cancelled = true;
    };
  }, [query]);
  return state;
}

function ConsentPage() {
  const query = currentQuery();
  const context = useConsentContext(query);

  if ("status" in context) {
    return context.status === "loading" ? (
      <PageLoading />
    ) : (
      <ConsentError
        native={asksForAppHost(query)}
        message="This connection request can't be shown."
      />
    );
  }
  if (!context.ok) {
    return (
      <ConsentError native={asksForAppHost(query)} message={context.message} />
    );
  }
  return (
    <AuthPageShell>
      <main className="flex w-full justify-center">
        {isNativeConsent(context) ? (
          <NativeConsentForm
            context={context}
            onSwitchAccount={() => void switchAccount(query)}
          />
        ) : (
          <ConsentForm
            context={context}
            onSwitchAccount={() => void switchAccount(query)}
          />
        )}
      </main>
    </AuthPageShell>
  );
}

function ConsentError({
  message,
  native,
}: {
  message: string;
  native: boolean;
}) {
  return (
    <main className="h-[100dvh]">
      <StatusScreen
        logo
        title={native ? "Can't sign in" : "Can't connect this app"}
      >
        <Alert variant="destructive">
          <CircleAlert />
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      </StatusScreen>
    </main>
  );
}
