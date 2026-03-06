import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { z } from "zod";
import { authClient, isCpuTimeoutError } from "@/client/auth-client";
import { CpuTimeoutWarning } from "@/components/CpuTimeoutWarning";
import { useCpuTimeoutRetry } from "@/hooks/useCpuTimeoutRetry";
import { getServerErrorMessage } from "@/client/errors";

const searchSchema = z.object({
  token: z.string().default(""),
  error: z.string().default(""),
  redirect: z.string().optional(),
});

export const Route = createFileRoute("/reset-password")({
  component: ResetPassword,
  validateSearch: searchSchema,
});

function ResetPassword() {
  const { token, error: urlError, redirect } = Route.useSearch();
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    if (urlError) {
      setError(
        urlError === "INVALID_TOKEN"
          ? "Invalid or expired reset link. Please request a new one."
          : "An error occurred. Please try again.",
      );
    }
  }, [urlError]);

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
    executeWithRetry,
  } = useCpuTimeoutRetry(async () => {
    try {
      const { error: resetError } = await authClient.resetPassword({
        token,
        newPassword,
      });

      if (resetError) {
        setError(resetError.message || "Failed to reset password.");
        return true;
      }

      if (hadRetries) {
        setRetrySuccess();
      } else {
        setSuccess(true);
        setTimeout(
          () =>
            navigate({
              to: "/sign-in",
              search: redirect ? { redirect } : undefined,
            }),
          2000,
        );
      }
      return true;
    } catch (err) {
      if (isCpuTimeoutError(err)) {
        return false;
      }
      setError(
        getServerErrorMessage(
          err,
          "Failed to reset password. Please try again.",
        ),
      );
      return true;
    }
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (newPassword !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    if (newPassword.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }

    if (!token) {
      setError("Invalid reset link. Please request a new password reset.");
      return;
    }

    executeWithRetry();
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
          <h2 className="card-title">Reset Password</h2>
          <p>Enter your new password below</p>

          {success ? (
            <div className="space-y-4 mt-4">
              <div className="alert alert-success text-sm">
                Password reset successful! Redirecting to sign in...
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit}>
              <div className="form-control">
                <label className="label">
                  <span className="label-text">New Password</span>
                </label>
                <input
                  id="newPassword"
                  type="password"
                  placeholder="Enter new password"
                  className="input input-bordered w-full"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  minLength={8}
                  disabled={!!urlError || isRunning}
                />
              </div>
              <div className="form-control">
                <label className="label">
                  <span className="label-text">Confirm Password</span>
                </label>
                <input
                  id="confirmPassword"
                  type="password"
                  placeholder="Confirm new password"
                  className="input input-bordered w-full"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  minLength={8}
                  disabled={!!urlError || isRunning}
                />
                <label className="label">
                  <span className="label-text-alt text-base-content/60">
                    Password must be at least 8 characters
                  </span>
                </label>
              </div>
              {error && <div className="text-sm text-error">{error}</div>}
              <button
                type="submit"
                className="btn btn-primary w-full"
                disabled={!!urlError || isRunning}
              >
                {isRunning ? "Resetting..." : "Reset Password"}
              </button>
            </form>
          )}

          <div className="flex justify-center mt-4">
            <p className="text-sm text-base-content/60">
              <Link
                to="/sign-in"
                search={redirect ? { redirect } : undefined}
                className="font-medium text-base-content hover:underline"
              >
                Back to Sign In
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
