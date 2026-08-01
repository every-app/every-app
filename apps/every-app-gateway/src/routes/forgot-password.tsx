import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { authClient, isCpuTimeoutError } from "@/client/auth-client";
import { CpuTimeoutWarning } from "@/client/components/CpuTimeoutWarning";
import { useCpuTimeoutRetry } from "@/client/hooks/useCpuTimeoutRetry";
import {
  getBetterAuthErrorMessage,
  getServerErrorMessage,
} from "@/client/errors";

const searchSchema = z.object({
  redirect: z.string().optional(),
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

export const Route = createFileRoute("/forgot-password")({
  component: ForgotPassword,
  validateSearch: searchSchema,
});

function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const navigate = useNavigate();
  const { redirect, return_to } = Route.useSearch();

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
    executeWithRetry: runForgotPassword,
  } = useCpuTimeoutRetry(async () => {
    try {
      const resetPasswordUrl = new URL(
        "/reset-password",
        window.location.origin,
      );
      if (redirect) {
        resetPasswordUrl.searchParams.set("redirect", redirect);
      }
      if (return_to) {
        resetPasswordUrl.searchParams.set("return_to", return_to);
      }

      const { error: resetError } = await authClient.requestPasswordReset({
        email,
        redirectTo: resetPasswordUrl.toString(),
      });

      if (resetError) {
        setError(
          getBetterAuthErrorMessage(resetError, "Failed to send reset email."),
        );
        return true;
      }
      if (hadRetries) {
        setRetrySuccess();
      } else {
        setSuccess(true);
      }
      return true;
    } catch (err) {
      console.error("Password reset error:", err);
      if (isCpuTimeoutError(err)) {
        return false;
      }
      setError(
        getServerErrorMessage(
          err,
          "Failed to send reset email. Please try again.",
        ),
      );
      return true;
    }
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess(false);
    runForgotPassword();
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
        onContinue={() =>
          navigate({
            to: "/sign-in",
            search: getAuthSearch({ redirect, return_to }),
          })
        }
      />
    );
  }

  return (
    <div className="flex h-screen items-center justify-center overflow-hidden">
      <div className="card auth-card">
        <div className="card-body">
          <h2 className="card-title">Forgot Password</h2>
          <p>
            Enter your email address and we'll send you a link to reset your
            password
          </p>

          {success ? (
            <div className="space-y-4 mt-4">
              <div className="alert alert-success text-sm">
                If an account exists for this email, we sent a password reset
                link.
              </div>
              <Link
                to="/sign-in"
                search={getAuthSearch({ redirect, return_to })}
                className="btn btn-primary w-full"
              >
                Back to Sign In
              </Link>
            </div>
          ) : (
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
              {error && <div className="text-sm text-error">{error}</div>}
              <button
                type="submit"
                className="btn btn-primary w-full"
                disabled={isRunning}
              >
                {isRunning ? "Sending..." : "Send Reset Link"}
              </button>
            </form>
          )}

          {!success && (
            <div className="flex justify-center mt-4">
              <p className="text-sm text-base-content/60">
                Remember your password?{" "}
                <Link
                  to="/sign-in"
                  search={getAuthSearch({ redirect, return_to })}
                  className="font-medium text-base-content hover:underline"
                >
                  Sign in
                </Link>
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
