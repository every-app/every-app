import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { authClient, isCpuTimeoutError } from "@/client/auth-client";
import { CpuTimeoutWarning } from "@/components/CpuTimeoutWarning";
import { useCpuTimeoutRetry } from "@/hooks/useCpuTimeoutRetry";

const searchSchema = z.object({
  redirect: z.string().optional(),
});

export const Route = createFileRoute("/forgot-password")({
  component: ForgotPassword,
  validateSearch: searchSchema,
});

function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const navigate = useNavigate();
  const { redirect } = Route.useSearch();

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
      if (typeof authClient.forgetPassword !== "function") {
        console.error("forgetPassword method not found on authClient");
        setError("Password reset is not configured. Please contact support.");
        return true;
      }

      // Include redirect param in the reset-password URL if present
      const resetPasswordUrl = redirect
        ? `${window.location.origin}/reset-password?redirect=${encodeURIComponent(redirect)}`
        : `${window.location.origin}/reset-password`;

      const { error: forgetError } = await authClient.forgetPassword({
        email,
        redirectTo: resetPasswordUrl,
      });

      if (forgetError) {
        setError(forgetError.message || "Failed to send reset email.");
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
        err instanceof Error
          ? err.message
          : "Failed to send reset email. Please try again.",
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
            search: redirect ? { redirect } : undefined,
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
              <div className="alert alert-warning text-sm">
                Email has not been configured for this gateway. Please tail the
                logs of every-app-gateway in Cloudflare in order to get the
                password reset link if you've forgotten your email.
              </div>
              <Link
                to="/sign-in"
                search={redirect ? { redirect } : undefined}
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
                  search={redirect ? { redirect } : undefined}
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
