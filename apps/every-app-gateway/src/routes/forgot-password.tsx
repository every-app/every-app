import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { authClient, CpuTimeoutError } from "@/client/auth-client";
import { CpuTimeoutWarning } from "@/components/CpuTimeoutWarning";

export const Route = createFileRoute("/forgot-password")({
  component: ForgotPassword,
});

function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [isCpuTimeout, setIsCpuTimeout] = useState(false);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setIsCpuTimeout(false);
    setSuccess(false);
    setLoading(true);

    try {
      if (typeof authClient.forgetPassword !== "function") {
        console.error("forgetPassword method not found on authClient");
        setError("Password reset is not configured. Please contact support.");
        setLoading(false);
        return;
      }

      const { error: forgetError } = await authClient.forgetPassword({
        email,
        redirectTo: `${window.location.origin}/reset-password`,
      });

      if (forgetError) {
        setError(forgetError.message || "Failed to send reset email.");
      } else {
        setSuccess(true);
      }
    } catch (err) {
      console.error("Password reset error:", err);
      if (err instanceof CpuTimeoutError) {
        setIsCpuTimeout(true);
      } else {
        setError(
          err instanceof Error
            ? err.message
            : "Failed to send reset email. Please try again.",
        );
      }
    } finally {
      setLoading(false);
    }
  };

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
              <Link to="/sign-in" className="btn btn-primary w-full">
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
                {loading ? "Sending..." : "Send Reset Link"}
              </button>
            </form>
          )}

          {!success && (
            <div className="flex justify-center mt-4">
              <p className="text-sm text-base-content/60">
                Remember your password?{" "}
                <Link
                  to="/sign-in"
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
