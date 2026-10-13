import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { authClient, isCpuTimeoutError } from "@/client/auth-client";
import { useQueryClient } from "@tanstack/react-query";
import { refetchCollectionsAfterAuth } from "@/client/tanstack-db";
import { CpuTimeoutWarning } from "@/client/components/CpuTimeoutWarning";
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
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    runSignIn();
  };

  // Show the game when retrying or when retries are exhausted
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

  return (
    <div className="flex h-screen items-center justify-center overflow-hidden bg-base-100">
      <div className="relative w-full max-w-md">
        <img
          src="/transparent-logo.png"
          alt="Logo"
          className="h-12 w-auto absolute left-1/2 -translate-x-1/2 -top-12"
        />
        <div className="card auth-card">
          <div className="card-body">
            <h2 className="card-title">Sign In</h2>

            {stalled && signedInAs ? (
              <div className="flex flex-col gap-3">
                {accessMessage ? (
                  <p className="text-error">{accessMessage}</p>
                ) : (
                  <p>
                    You're signed in as <strong>{signedInAs}</strong>, but the
                    page you were going to sent you back here.
                  </p>
                )}
                <button
                  type="button"
                  className="btn btn-primary w-full"
                  onClick={continueToDestination}
                >
                  {accessMessage ? "Continue" : "Try again"}
                </button>
              </div>
            ) : (
              <>
                {methods?.accessEmail && !signedInAs && (
                  <div className="alert text-sm">
                    <span>
                      Cloudflare Access says you're{" "}
                      <strong>{methods.accessEmail}</strong>, which doesn't give
                      you an account here by itself.{" "}
                      {passwordSignIn
                        ? "If you have an account with this email, sign in below once to connect it; otherwise ask an admin to invite you."
                        : "Ask an admin to invite you."}{" "}
                      <a href={ACCESS_SIGN_OUT_PATH} className="link">
                        Not you? Sign out of Access
                      </a>
                    </span>
                  </div>
                )}

                {accessMessage && (
                  <div className="text-sm text-error">{accessMessage}</div>
                )}

                {accessProvider && (
                  <button
                    type="button"
                    className="btn btn-outline w-full"
                    onClick={() => void signInWithAccess()}
                    disabled={redirecting || isRunning}
                  >
                    {redirecting
                      ? "Redirecting..."
                      : `Continue with ${accessProvider.label}`}
                  </button>
                )}

                {passwordSignIn && (
                  <>
                    {accessProvider && (
                      <div className="divider text-xs text-base-content/60">
                        or
                      </div>
                    )}
                    <p>Enter your email and password to sign in</p>

                    <form onSubmit={handleSubmit}>
                      <div className="form-control">
                        <label className="label">
                          <span className="label-text">Email</span>
                        </label>
                        <input
                          id="email"
                          type="email"
                          placeholder="you@example.com"
                          className="input input-bordered w-full"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          required
                          disabled={isRunning || redirecting}
                        />
                      </div>
                      <div className="form-control">
                        <label className="label">
                          <span className="label-text">Password</span>
                        </label>
                        <input
                          id="password"
                          type="password"
                          placeholder="Enter your password"
                          className="input input-bordered w-full"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          required
                          disabled={isRunning || redirecting}
                        />
                      </div>
                      {error && (
                        <div className="text-sm text-error">{error}</div>
                      )}
                      <button
                        type="submit"
                        className="btn btn-primary w-full"
                        disabled={isRunning || redirecting}
                      >
                        {isRunning ? "Signing in..." : "Sign In"}
                      </button>
                    </form>

                    <div className="text-left">
                      <p className="text-sm text-base-content/60">
                        Don't have an account?{" "}
                        <Link
                          to="/sign-up"
                          search={getAuthSearch({ redirect, return_to })}
                          className="font-medium text-base-content hover:underline"
                        >
                          Sign up
                        </Link>
                      </p>
                      <p className="text-sm text-base-content/60">
                        <Link
                          to="/forgot-password"
                          search={getAuthSearch({ redirect, return_to })}
                          className="font-medium text-base-content hover:underline"
                        >
                          Forgot password?
                        </Link>
                      </p>
                    </div>
                  </>
                )}

                {!passwordSignIn &&
                  !accessProvider &&
                  !methods?.accessEmail && (
                    <p>
                      Open this gateway through Cloudflare Access to sign in.
                    </p>
                  )}

                {!passwordSignIn && error && (
                  <div className="text-sm text-error">{error}</div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
