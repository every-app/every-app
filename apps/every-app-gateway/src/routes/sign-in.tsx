import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { z } from "zod";
import { CircleAlert, Info, ShieldCheck } from "lucide-react";
import { authClient, isCpuTimeoutError } from "@/client/auth-client";
import { useQueryClient } from "@tanstack/react-query";
import { refetchCollectionsAfterAuth } from "@/client/tanstack-db";
import { CpuTimeoutWarning } from "@/client/components/CpuTimeoutWarning";
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
  accessSignInErrorMessage,
  mayAutoContinue,
  shouldLinkAfterPasswordSignIn,
  useSignInMethods,
} from "@/client/sign-in-methods";
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
  // Set by Better Auth when a Cloudflare Access sign-in comes back refused.
  error: z.string().optional(),
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

/** This page's own URL, for coming back to it after Cloudflare Access. */
function signInPath(search: { redirect?: string; return_to?: string }) {
  const params = new URLSearchParams(getAuthSearch(search));
  const query = params.toString();
  return query ? `/sign-in?${query}` : "/sign-in";
}

export const Route = createFileRoute("/sign-in")({
  component: SignIn,
  validateSearch: searchSchema,
});

function SignIn() {
  const [error, setError] = useState("");
  const [redirecting, setRedirecting] = useState(false);
  const [stalled, setStalled] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { redirect, return_to, error: accessError } = Route.useSearch();
  const safeRedirect = getSafeRedirect(redirect);
  const session = useSession();
  const { data: methods } = useSignInMethods();
  const accessProvider = methods?.providers[0];
  // Until the methods load (or if they can't), offer the password form.
  const passwordSignIn = methods?.emailPassword ?? true;
  const backHere = signInPath({ redirect, return_to });

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

  const signInWithAccess = async () => {
    if (!accessProvider) return;
    setError("");
    setRedirecting(true);
    // Back to this page either way: it moves on once signed in, and shows
    // what went wrong otherwise.
    const { error: startError } = await authClient.signIn.social({
      provider: accessProvider.id,
      callbackURL: backHere,
      errorCallbackURL: backHere,
    });
    if (startError) {
      setRedirecting(false);
      setError(
        accessSignInErrorMessage("", accessProvider.label, passwordSignIn),
      );
    }
  };

  // The schema only checks the fields. The sign-in runs in `runSignIn`, which
  // retries on a CPU timeout, so it reads the values from the form each try.
  const form = useAppForm({
    defaultValues: { email: "", password: "" },
    validators: { onSubmit: signInSchema },
    // Every submit clears the last server error, a refused one included.
    onSubmitInvalid: () => setError(""),
    onSubmit: () => {
      setError("");
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
            // An Access sign-in found this account but couldn't link it:
            // now that the password proved it, connect Access.
            if (accessProvider && shouldLinkAfterPasswordSignIn(accessError)) {
              setRedirecting(true);
              await authClient.linkSocial({
                provider: accessProvider.id,
                callbackURL: backHere,
                errorCallbackURL: backHere,
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

      if (signInError) {
        setError(
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
        );
      }
      return true;
    } catch (err) {
      console.error("Sign in error:", err);
      if (isCpuTimeoutError(err)) {
        return false;
      }
      setError(
        getServerErrorMessage(err, "Failed to sign in. Please try again."),
      );
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
      ? accessSignInErrorMessage(
          accessError,
          accessProvider?.label ?? "Cloudflare Access",
          passwordSignIn,
          methods?.accessEmail ?? null,
        )
      : null;
  const isStalled = Boolean(stalled && signedInAs);
  const authSearch = getAuthSearch({ redirect, return_to });

  return (
    <AuthPageShell>
      <AuthCard
        title="Sign in"
        description={
          !isStalled && passwordSignIn && !accessProvider
            ? "Enter your email and password to sign in."
            : undefined
        }
        footer={
          !isStalled && passwordSignIn ? (
            <>
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
            {accessMessage ? (
              <ErrorAlert>{accessMessage}</ErrorAlert>
            ) : (
              <p className="text-sm text-muted-foreground">
                You're signed in as{" "}
                <strong className="font-medium text-foreground">
                  {signedInAs}
                </strong>
                , but the page you were going to sent you back here.
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
            {methods?.accessEmail && !signedInAs ? (
              <Alert variant="info">
                <Info />
                <AlertDescription>
                  Cloudflare Access says you're{" "}
                  <strong className="font-medium text-foreground">
                    {methods.accessEmail}
                  </strong>
                  , which doesn't give you an account here by itself.{" "}
                  {passwordSignIn
                    ? "If you have an account with this email, sign in below once to connect it; otherwise ask an admin to invite you."
                    : "Ask an admin to invite you."}{" "}
                  <a href={ACCESS_SIGN_OUT_PATH}>Not you? Sign out of Access</a>
                </AlertDescription>
              </Alert>
            ) : null}

            {accessMessage ? <ErrorAlert>{accessMessage}</ErrorAlert> : null}

            {accessProvider ? (
              <Button
                variant="outline"
                className="w-full bg-card font-semibold dark:border-border dark:bg-card"
                onClick={() => void signInWithAccess()}
                disabled={isRunning}
                pending={redirecting}
              >
                {redirecting ? null : <ShieldCheck data-icon="inline-start" />}
                {redirecting
                  ? "Redirecting..."
                  : `Continue with ${accessProvider.label}`}
              </Button>
            ) : null}

            {passwordSignIn ? (
              <>
                {accessProvider ? <AuthDivider /> : null}
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
                          disabled={isRunning || redirecting}
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
                          disabled={isRunning || redirecting}
                        />
                      )}
                    </form.AppField>
                    {error ? <ErrorAlert>{error}</ErrorAlert> : null}
                    <Button
                      type="submit"
                      className={authSubmitClassName}
                      pending={isRunning}
                      disabled={redirecting}
                    >
                      {isRunning ? "Signing in..." : "Sign in"}
                    </Button>
                  </form.Form>
                </form.AppForm>
              </>
            ) : null}

            {!passwordSignIn && !accessProvider && !methods?.accessEmail ? (
              <p className="text-sm text-muted-foreground">
                Open this gateway through Cloudflare Access to sign in.
              </p>
            ) : null}

            {!passwordSignIn && error ? <ErrorAlert>{error}</ErrorAlert> : null}
          </>
        )}
      </AuthCard>
    </AuthPageShell>
  );
}

function ErrorAlert({ children }: { children: ReactNode }) {
  return (
    <Alert variant="destructive">
      <CircleAlert />
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}
