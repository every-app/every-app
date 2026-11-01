import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { z } from "zod";
import { CircleAlert, Info } from "lucide-react";
import { authClient, isCpuTimeoutError } from "@/client/auth-client";
import { useQueryClient } from "@tanstack/react-query";
import { refetchCollectionsAfterAuth } from "@/client/tanstack-db";
import { CpuTimeoutWarning } from "@/client/components/CpuTimeoutWarning";
import { Address, withAddresses } from "@/client/components/auth/Address";
import { SignInProviderIcon } from "@/client/components/auth/SignInProviderIcon";
import {
  AuthCard,
  AuthDivider,
  AuthPageShell,
  authInputClassName,
  authLinkClassName,
  authSubmitClassName,
} from "@/client/components/auth/AuthPageShell";
import { useAppForm } from "@/client/components/form/useAppForm";
import { Alert, AlertDescription } from "@/client/components/ui/alert";
import { Button } from "@/client/components/ui/button";
import { useCpuTimeoutRetry } from "@/client/hooks/useCpuTimeoutRetry";
import { useSession } from "@/client/hooks/useSession";
import {
  ACCESS_SIGN_OUT_PATH,
  accessEmailMismatchMessage,
  mayAutoContinue,
  shouldLinkAfterPasswordSignIn,
  signInErrorLabel,
  signInErrorMessage,
  signInErrorProvider,
  signInPageParts,
  useSignInMethods,
} from "@/client/sign-in-methods";
import { verifyEmailSearch } from "@/client/verify-email";
import { getSafeRedirect, getSafeReturnTo, isWorkerRoute } from "@/utils/auth";
import {
  getBetterAuthErrorMessage,
  getServerErrorMessage,
} from "@/client/errors";

const searchSchema = z.object({
  redirect: z.string().optional(),
  // Absolute URL back to an app subdomain, set by the perimeter when it
  // redirects an unauthenticated navigation to the login page.
  return_to: z.string().optional(),
  // Set by Better Auth when a provider sign-in (Cloudflare Access, Google…)
  // comes back refused.
  error: z.string().optional(),
  // Which provider that was: this page puts it on every error URL it hands
  // Better Auth, so a refusal names the right one and the password sign-in
  // after `account_not_linked` connects that one.
  provider: z.string().optional(),
});

const signInSchema = z.object({
  email: z.string().trim().email("Enter a valid email address."),
  password: z.string().min(1, "Enter your password."),
});

function getAuthSearch({
  redirect,
  return_to,
}: {
  redirect?: string;
  return_to?: string;
}) {
  const search: { redirect?: string; return_to?: string } = {};
  if (redirect) {
    search.redirect = redirect;
  }
  if (return_to) {
    search.return_to = return_to;
  }
  return redirect || return_to ? search : undefined;
}

/**
 * This page's own URL, for coming back to it after a provider; with
 * `provider` for the error URL, so a refusal says which one it was.
 */
function signInPath(
  search: { redirect?: string; return_to?: string },
  provider?: string,
) {
  const params = new URLSearchParams(getAuthSearch(search));
  if (provider) params.set("provider", provider);
  const query = params.toString();
  return query ? `/sign-in?${query}` : "/sign-in";
}

export const Route = createFileRoute("/sign-in")({
  component: SignIn,
  validateSearch: searchSchema,
});

/** What a sign-in attempt came back with; the code tells Access's refusals apart. */
type SignInError = { code?: string; message: string };

function SignIn() {
  const [error, setError] = useState<SignInError | null>(null);
  // The provider whose sign-in is under way (the browser is leaving).
  const [redirecting, setRedirecting] = useState<string | null>(null);
  const [stalled, setStalled] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const {
    redirect,
    return_to,
    error: accessError,
    provider: providerParam,
  } = Route.useSearch();
  const safeRedirect = getSafeRedirect(redirect);
  const session = useSession();
  const { data: methods } = useSignInMethods();
  // The provider the `?error=` came back from, if one did.
  const errorProvider = signInErrorProvider(
    methods,
    providerParam,
    accessError,
  );
  const errorLabel = signInErrorLabel(errorProvider, providerParam);
  // Until the methods load (or if they can't), offer the password form.
  const passwordSignIn = methods?.emailPassword ?? true;
  const backHere = signInPath({ redirect, return_to });
  const backHereFrom = (id: string) => signInPath({ redirect, return_to }, id);

  // Where to land after login: a validated app-subdomain URL from the
  // perimeter wins over the internal redirect path. Cross-origin, so it must
  // be a full browser navigation, not a router transition.
  const destination = () => getSafeReturnTo(return_to) ?? safeRedirect;
  const continueToDestination = () => {
    const safeReturnTo = getSafeReturnTo(return_to);
    if (safeReturnTo) {
      window.location.assign(safeReturnTo);
    } else if (isWorkerRoute(safeRedirect)) {
      window.location.assign(safeRedirect);
    } else {
      navigate({ to: safeRedirect });
    }
  };

  // Already signed in (Cloudflare Access's outer ring signs a browser in by
  // itself, and an Access sign-in comes back here): move on. Only on a
  // session checked now, not the copy cached from an earlier visit.
  const continued = useRef(false);
  useEffect(() => {
    if (
      continued.current ||
      !session.isFetchedAfterMount ||
      !session.data?.user
    ) {
      return;
    }
    continued.current = true;
    if (
      // Signed in, but connecting Cloudflare Access just failed: say why.
      !accessError &&
      mayAutoContinue(
        destination(),
        typeof window !== "undefined" ? window.sessionStorage : null,
      )
    ) {
      continueToDestination();
    } else {
      setStalled(true);
    }
  }, [session.isFetchedAfterMount, session.data?.user]);

  const signInWith = async (provider: { id: string; label: string }) => {
    setError(null);
    setRedirecting(provider.id);
    // Back to this page either way: it moves on once signed in, and shows
    // what went wrong otherwise, knowing from `provider=` which one it was.
    const { error: startError } = await authClient.signIn.social({
      provider: provider.id,
      callbackURL: backHere,
      errorCallbackURL: backHereFrom(provider.id),
    });
    if (startError) {
      setRedirecting(null);
      // SIGNIN_PROVIDER_UNAVAILABLE: an SSO issuer that can't be reached.
      setError({
        message: signInErrorMessage(
          startError.code ?? "",
          provider.label,
          passwordSignIn,
        ),
      });
    }
  };

  // The schema only checks the fields. The sign-in runs in `runSignIn`, which
  // retries on a CPU timeout, so it reads the values from the form each try.
  const form = useAppForm({
    defaultValues: { email: "", password: "" },
    validators: { onSubmit: signInSchema },
    // Every submit clears the last server error, a refused one included.
    onSubmitInvalid: () => setError(null),
    onSubmit: () => {
      setError(null);
      runSignIn();
    },
  });

  const {
    isRunning,
    attemptCount,
    maxRetries,
    hasExhaustedRetries,
    secondsUntilRetry,
    isRetrySuccess,
    showWarning,
    hadRetries,
    setRetrySuccess,
    executeWithRetry: runSignIn,
  } = useCpuTimeoutRetry(async () => {
    // Trimmed as the browser trims a type="email" input's value.
    const email = form.state.values.email.trim();
    const { password } = form.state.values;
    try {
      const { error: signInError } = await authClient.signIn.email(
        { email, password },
        {
          onSuccess: async () => {
            continued.current = true;
            // A provider sign-in found this account but couldn't link it:
            // now that the password proved it, connect that provider.
            if (errorProvider && shouldLinkAfterPasswordSignIn(accessError)) {
              setRedirecting(errorProvider.id);
              await authClient.linkSocial({
                provider: errorProvider.id,
                callbackURL: backHere,
                errorCallbackURL: backHereFrom(errorProvider.id),
              });
              return;
            }
            await queryClient.refetchQueries({ queryKey: ["auth", "session"] });
            refetchCollectionsAfterAuth();
            if (hadRetries) {
              setRetrySuccess();
            } else {
              continueToDestination();
            }
          },
        },
      );

      if (signInError?.code === "EMAIL_NOT_VERIFIED") {
        // Hosted accounts sign in once verified: the verify page resends.
        navigate({
          to: "/verify-email",
          search: verifyEmailSearch({ email, redirect, return_to }),
        });
        return true;
      }
      if (signInError) {
        setError({
          code: signInError.code,
          message:
            signInError.code === "ACCESS_EMAIL_MISMATCH"
              ? // Behind the outer ring: Access knows this browser by another
                // email than the account's.
                accessEmailMismatchMessage(methods?.accessEmail ?? null, email)
              : signInError.code === "PASSWORD_SIGN_IN_DISABLED" ||
                  signInError.code === "ACCESS_REQUIRED"
                ? (signInError.message ?? "Password sign-in is turned off.")
                : getBetterAuthErrorMessage(
                    signInError,
                    "Invalid email or password.",
                  ),
        });
      }
      return true;
    } catch (err) {
      console.error("Sign in error:", err);
      if (isCpuTimeoutError(err)) {
        return false;
      }
      setError({
        message: getServerErrorMessage(
          err,
          "Failed to sign in. Please try again.",
        ),
      });
      return true;
    }
  });

  // Show the retry status while retrying or once retries are exhausted
  if (showWarning || isRetrySuccess) {
    return (
      <CpuTimeoutWarning
        attemptCount={attemptCount}
        maxRetries={maxRetries}
        hasExhaustedRetries={hasExhaustedRetries}
        secondsUntilRetry={secondsUntilRetry}
        isSuccess={isRetrySuccess}
        onContinue={continueToDestination}
      />
    );
  }

  const signedInAs = session.data?.user?.email;
  const accessMessage =
    accessError && !error
      ? signInErrorMessage(
          accessError,
          errorLabel,
          passwordSignIn,
          methods?.accessEmail ?? null,
        )
      : null;
  const isStalled = Boolean(stalled && signedInAs);
  const authSearch = getAuthSearch({ redirect, return_to });
  // The provider refusal on screen, if any: the one the URL brought (shown
  // while no attempt has failed since) or a refused password sign-in.
  const errorCode =
    accessMessage && accessError
      ? accessError
      : error?.code === "ACCESS_EMAIL_MISMATCH"
        ? error.code
        : null;
  const parts = signInPageParts(methods, {
    signedIn: Boolean(signedInAs),
    errorCode,
  });
  const accessAlert = accessMessage ? (
    <ErrorAlert signOut={parts.accessSignOut}>
      {withAddresses(accessMessage)}
    </ErrorAlert>
  ) : null;

  return (
    <AuthPageShell>
      <AuthCard
        title="Sign in"
        footer={
          !isStalled && passwordSignIn ? (
            <>
              {parts.signUp ? (
                <p>
                  Don't have an account?{" "}
                  <Link
                    to="/sign-up"
                    search={authSearch}
                    className={authLinkClassName}
                  >
                    Sign up
                  </Link>
                </p>
              ) : null}
              <p>
                <Link
                  to="/forgot-password"
                  search={authSearch}
                  className={authLinkClassName}
                >
                  Forgot password?
                </Link>
              </p>
            </>
          ) : undefined
        }
      >
        {isStalled ? (
          <>
            {accessAlert ?? (
              <p className="text-sm text-muted-foreground">
                You're signed in as{" "}
                <Address after=",">{signedInAs ?? ""}</Address> but the page you
                were going to sent you back here.
              </p>
            )}
            <Button
              className={authSubmitClassName}
              onClick={continueToDestination}
            >
              {accessMessage ? "Continue" : "Try again"}
            </Button>
          </>
        ) : (
          <>
            {parts.accessNote && methods?.accessEmail ? (
              <Alert variant="info">
                <Info />
                <AlertDescription>
                  Cloudflare Access says you're{" "}
                  <Address after=",">{methods.accessEmail}</Address> which
                  doesn't give you an account here by itself.{" "}
                  {passwordSignIn
                    ? "If you have an account with this email, sign in below once to connect it; otherwise ask an admin to invite you."
                    : "Ask an admin to invite you."}{" "}
                  <AccessSignOut />
                </AlertDescription>
              </Alert>
            ) : null}

            {accessAlert}

            {parts.buttons.length > 0 ? (
              <div className="flex flex-col gap-2">
                {parts.buttons.map((provider) => (
                  <Button
                    key={provider.id}
                    variant="outline"
                    className="w-full bg-card font-semibold dark:border-border dark:bg-card"
                    onClick={() => void signInWith(provider)}
                    disabled={
                      isRunning ||
                      (redirecting !== null && redirecting !== provider.id)
                    }
                    pending={redirecting === provider.id}
                  >
                    {redirecting === provider.id ? null : (
                      <SignInProviderIcon id={provider.id} />
                    )}
                    Continue with {provider.label}
                  </Button>
                ))}
              </div>
            ) : null}

            {passwordSignIn ? (
              <>
                {parts.buttons.length > 0 ? <AuthDivider /> : null}
                <form.AppForm>
                  <form.Form className="space-y-4">
                    <form.AppField name="email">
                      {(field) => (
                        <field.TextField
                          label="Email"
                          type="email"
                          placeholder="you@example.com"
                          className={authInputClassName}
                          autoComplete="email"
                          required
                          disabled={isRunning || redirecting !== null}
                        />
                      )}
                    </form.AppField>
                    <form.AppField name="password">
                      {(field) => (
                        <field.TextField
                          label="Password"
                          type="password"
                          placeholder="Enter your password"
                          className={authInputClassName}
                          autoComplete="current-password"
                          required
                          disabled={isRunning || redirecting !== null}
                        />
                      )}
                    </form.AppField>
                    {error ? (
                      <ErrorAlert signOut={parts.accessSignOut}>
                        {withAddresses(error.message)}
                      </ErrorAlert>
                    ) : null}
                    <Button
                      type="submit"
                      className={authSubmitClassName}
                      pending={isRunning}
                      disabled={redirecting !== null}
                    >
                      Sign in
                    </Button>
                  </form.Form>
                </form.AppForm>
              </>
            ) : null}

            {!passwordSignIn &&
            !methods?.providers.length &&
            !methods?.accessEmail ? (
              <p className="text-sm text-muted-foreground">
                Open this gateway through Cloudflare Access to sign in.
              </p>
            ) : null}

            {!passwordSignIn && error ? (
              <ErrorAlert signOut={parts.accessSignOut}>
                {withAddresses(error.message)}
              </ErrorAlert>
            ) : null}
          </>
        )}
      </AuthCard>
    </AuthPageShell>
  );
}

function ErrorAlert({
  children,
  signOut = false,
}: {
  children: ReactNode;
  /** End with "Not you? Sign out of Access": the refusal was Access's. */
  signOut?: boolean;
}) {
  return (
    <Alert variant="destructive">
      <CircleAlert />
      <AlertDescription>
        {children}
        {signOut ? (
          <>
            {" "}
            <AccessSignOut />
          </>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

function AccessSignOut() {
  return <a href={ACCESS_SIGN_OUT_PATH}>Not you? Sign out of Access</a>;
}
