import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { authClient } from "@/client/auth-client";
import { ConsentForm } from "@/client/components/oauth/ConsentForm";
import { getConsentContext } from "@/serverFunctions/oauthConsent";

/**
 * The consent page for an AI app connecting to the gateway's /mcp. It only
 * displays: /oauth/authorize validated the request and started a one-time
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

/** Sign in, then come back to this same consent page. */
function signInAndReturn(query: string): void {
  window.location.assign(
    `/sign-in?redirect=${encodeURIComponent(`/oauth/consent${query}`)}`,
  );
}

async function switchAccount(query: string): Promise<void> {
  await authClient.signOut();
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
      <main className="min-h-screen bg-base-100 grid place-items-center p-6">
        <span className="loading loading-spinner loading-lg" />
      </main>
    ) : (
      <ConsentError message="This connection request can't be shown." />
    );
  }
  if (!context.ok) return <ConsentError message={context.message} />;
  return (
    <ConsentForm
      context={context}
      onSwitchAccount={() => void switchAccount(query)}
    />
  );
}

function ConsentError({ message }: { message: string }) {
  return (
    <main className="min-h-screen bg-base-100 grid place-items-center p-6">
      <section className="w-full max-w-lg rounded-lg border border-error/30 bg-base-100 p-6 shadow-sm">
        <h1 className="text-xl font-bold">Can't connect this app</h1>
        <p className="mt-2 text-base-content/70">{message}</p>
      </section>
    </main>
  );
}
