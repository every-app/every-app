import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { CpuTimeoutError } from "@/client/auth-client";
import { CpuTimeoutWarning } from "@/components/CpuTimeoutWarning";
import { acceptInvitation } from "@/serverFunctions/admin";

const searchSchema = z.object({
  token: z.string().optional(),
});

export const Route = createFileRoute("/accept-invitation")({
  validateSearch: searchSchema,
  component: AcceptInvitation,
});

function AcceptInvitation() {
  const { token } = Route.useSearch();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [isCpuTimeout, setIsCpuTimeout] = useState(false);

  if (!token) {
    return (
      <div className="flex h-screen items-center justify-center overflow-hidden">
        <div className="relative w-full max-w-md">
          <img
            src="/transparent-logo.png"
            alt="Logo"
            className="h-12 w-auto absolute left-1/2 -translate-x-1/2 -top-12"
          />
          <div className="card auth-card">
            <div className="card-body text-center">
              <h2 className="card-title justify-center">Invalid Invitation</h2>
              <p className="text-base-content/70 mt-2">
                This invitation link is invalid or missing a token. Please
                request a new invitation from the administrator.
              </p>
              <div className="mt-4">
                <Link to="/sign-in" className="btn btn-primary">
                  Go to Sign In
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (success) {
    return (
      <div className="flex h-screen items-center justify-center overflow-hidden">
        <div className="relative w-full max-w-md">
          <img
            src="/transparent-logo.png"
            alt="Logo"
            className="h-12 w-auto absolute left-1/2 -translate-x-1/2 -top-12"
          />
          <div className="card auth-card">
            <div className="card-body text-center">
              <h2 className="card-title justify-center">Account Created!</h2>
              <p className="text-base-content/70 mt-2">
                Your account has been set up successfully. You can now sign in
                with your new password.
              </p>
              <div className="mt-4">
                <Link to="/sign-in" className="btn btn-primary">
                  Sign In
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setIsCpuTimeout(false);

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    setLoading(true);

    try {
      // Accept invitation: validate token, set password, and activate user
      await acceptInvitation({
        data: {
          token,
          password,
        },
      });

      setSuccess(true);
    } catch (err) {
      console.error("Accept invitation error:", err);
      if (err instanceof CpuTimeoutError) {
        setIsCpuTimeout(true);
      } else {
        setError(
          err instanceof Error
            ? err.message
            : "Failed to set password. Please try again.",
        );
      }
      setLoading(false);
    }
  };

  return (
    <div className="flex h-screen items-center justify-center overflow-hidden">
      <div className="relative w-full max-w-md">
        <img
          src="/transparent-logo.png"
          alt="Logo"
          className="h-12 w-auto absolute left-1/2 -translate-x-1/2 -top-12"
        />
        <div className="card auth-card">
          <div className="card-body">
            <h2 className="card-title">Accept Invitation</h2>
            <p>Complete your account setup by creating a password</p>

            <form onSubmit={handleSubmit}>
              <div className="form-control">
                <label className="label">
                  <span className="label-text">Password</span>
                </label>
                <input
                  id="password"
                  type="password"
                  placeholder="Create a password"
                  className="input input-bordered w-full"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                />
                <label className="label">
                  <span className="label-text-alt text-base-content/60">
                    Password must be at least 8 characters
                  </span>
                </label>
              </div>
              <div className="form-control">
                <label className="label">
                  <span className="label-text">Confirm Password</span>
                </label>
                <input
                  id="confirmPassword"
                  type="password"
                  placeholder="Confirm your password"
                  className="input input-bordered w-full"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  minLength={8}
                />
              </div>
              {isCpuTimeout ? (
                <CpuTimeoutWarning />
              ) : (
                error && <div className="text-sm text-error">{error}</div>
              )}
              <button
                type="submit"
                className="btn btn-primary w-full"
                disabled={loading}
              >
                {loading ? "Setting up account..." : "Complete Setup"}
              </button>
            </form>

            <div className="flex justify-center mt-4">
              <p className="text-sm text-base-content/60">
                Already have an account?{" "}
                <Link
                  to="/sign-in"
                  className="font-medium text-base-content hover:underline"
                >
                  Sign in
                </Link>
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
