import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { authClient, isCpuTimeoutError } from "@/client/auth-client";
import { useQueryClient } from "@tanstack/react-query";
import { refetchCollectionsAfterAuth } from "@/client/tanstack-db";
import { CpuTimeoutWarning } from "@/client/components/CpuTimeoutWarning";
import { useCpuTimeoutRetry } from "@/client/hooks/useCpuTimeoutRetry";
import { getSafeRedirect, getSafeReturnTo } from "@/utils/auth";
import {
  getBetterAuthErrorMessage,
  getServerErrorMessage,
} from "@/client/errors";

const searchSchema = z.object({
  redirect: z.string().optional(),
  // Absolute URL back to an app subdomain, set by the perimeter when it
  // redirects an unauthenticated navigation to the login page.
  return_to: z.string().optional(),
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

export const Route = createFileRoute("/sign-in")({
  component: SignIn,
  validateSearch: searchSchema,
});

function SignIn() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { redirect, return_to } = Route.useSearch();
  const safeRedirect = getSafeRedirect(redirect);

  // Where to land after login: a validated app-subdomain URL from the
  // perimeter wins over the internal redirect path. Cross-origin, so it must
  // be a full browser navigation, not a router transition.
  const continueToDestination = () => {
    const safeReturnTo = getSafeReturnTo(return_to);
    if (safeReturnTo) {
      window.location.assign(safeReturnTo);
    } else {
      navigate({ to: safeRedirect });
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
          getBetterAuthErrorMessage(signInError, "Invalid email or password."),
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
                  disabled={isRunning}
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
                  disabled={isRunning}
                />
              </div>
              {error && <div className="text-sm text-error">{error}</div>}
              <button
                type="submit"
                className="btn btn-primary w-full"
                disabled={isRunning}
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
          </div>
        </div>
      </div>
    </div>
  );
}
