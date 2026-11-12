import { useEffect, useState } from "react";
import { CircleAlert } from "lucide-react";
import { signOutAndForget } from "@/client/sign-out";
import { useSignInMethods } from "@/client/sign-in-methods";
import { StatusScreen } from "@/client/components/StatusScreen";
import { Alert, AlertDescription } from "@/client/components/ui/alert";

/**
 * What the consent pages share (routes/oauth/consent.tsx and
 * app-access.tsx): the page's context, loaded once outside the persisted
 * query cache, since it holds a one-use handle or state that has no
 * business in localStorage. A signed-out visitor is sent to sign in and
 * back to the same page, which is also what switching account does. Behind
 * Cloudflare Access there is no switching here: the outer ring signs the
 * browser straight back in as the person Access names, so `switchAccount`
 * is undefined there (and until the sign-in methods say).
 */
export function useConsentPage<Result extends object>(
  path: string,
  load: (query: string) => Promise<Result>,
) {
  type Shown = Exclude<Result, { signedOut: true }>;
  const query = window.location.search;
  const signInAndReturn = () =>
    window.location.assign(
      `/sign-in?redirect=${encodeURIComponent(`${path}${query}`)}`,
    );
  const [context, setContext] = useState<
    { status: "loading" } | { status: "failed" } | Shown
  >({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    load(query).then(
      (result) => {
        if (cancelled) return;
        if ("signedOut" in result) signInAndReturn();
        else setContext(result as Shown);
      },
      () => !cancelled && setContext({ status: "failed" }),
    );
    return () => {
      cancelled = true;
    };
  }, [query]);
  const { data: methods } = useSignInMethods();
  const switchAccount =
    methods && !methods.accessEmail
      ? () => void signOutAndForget().then(signInAndReturn)
      : undefined;
  return { query, context, switchAccount };
}

export function ConsentPageError({
  title,
  message,
}: {
  title: string;
  message: string;
}) {
  return (
    <main className="h-[100dvh]">
      <StatusScreen logo title={title}>
        <Alert variant="destructive">
          <CircleAlert />
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      </StatusScreen>
    </main>
  );
}
