import { useCallback, useEffect, useRef, useState } from "react";
import { CircleAlert } from "lucide-react";
import { signOutAndForget } from "@/client/sign-out";
import { useSignInMethods } from "@/client/sign-in-methods";
import { StatusScreen } from "@/client/components/StatusScreen";
import { Alert, AlertDescription } from "@/client/components/ui/alert";

/**
 * What the consent pages share (routes/oauth/consent.tsx, app-access.tsx
 * and composio.tsx): the page's context, loaded once outside the persisted
 * query cache, since it holds a one-use handle or state that has no
 * business in localStorage. A signed-out visitor is sent to sign in and
 * back to the same page, which is also what switching account does. Behind
 * Cloudflare Access there is no switching here: the outer ring signs the
 * browser straight back in as the person Access names, so `switchAccount`
 * is undefined there (and until the sign-in methods say). `reload` loads
 * the context again, for a page whose next step waits on something done
 * elsewhere; what is shown stays until the new context arrives.
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
  // The load whose answer is shown: a later one replaces an earlier one's.
  const latest = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++latest.current;
    const current = () => mine === latest.current;
    await load(query).then(
      (result) => {
        if (!current()) return;
        if ("signedOut" in result) signInAndReturn();
        else setContext(result as Shown);
      },
      () => current() && setContext({ status: "failed" }),
    );
  }, [query]);
  useEffect(() => {
    void reload();
    return () => {
      latest.current++;
    };
  }, [reload]);
  const { data: methods } = useSignInMethods();
  const switchAccount =
    methods && !methods.accessEmail
      ? () => void signOutAndForget().then(signInAndReturn)
      : undefined;
  return { query, context, switchAccount, reload };
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
