import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useState } from "react";
import { authClient, isCpuTimeoutError } from "@/client/auth-client";
import { useQueryClient } from "@tanstack/react-query";
import { refetchCollectionsAfterAuth } from "@/client/tanstack-db";
import { CpuTimeoutWarning } from "@/components/CpuTimeoutWarning";
import { useCpuTimeoutRetry } from "@/hooks/useCpuTimeoutRetry";

export const Route = createFileRoute("/sign-in")({
  component: SignIn,
});

function SignIn() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const attemptSignIn = async (): Promise<boolean> => {
    try {
      const { error: signInError } = await authClient.signIn.email(
        { email, password },
        {
          onSuccess: async () => {
            await queryClient.refetchQueries({ queryKey: ["auth", "session"] });
            refetchCollectionsAfterAuth();
            navigate({ to: "/" });
          },
        },
      );

      if (signInError) {
        setError(signInError.message || "Invalid email or password.");
        return true;
      }
      return true;
    } catch (err) {
      console.error("Sign in error:", err);
      if (isCpuTimeoutError(err)) {
        return false;
      }
      setError(
        err instanceof Error
          ? err.message
          : "Failed to sign in. Please try again.",
      );
      return true;
    }
  };

  const {
    isRunning,
    attemptCount,
    maxRetries,
    hasExhaustedRetries,
    secondsUntilRetry,
    showWarning,
    executeWithRetry: runSignIn,
  } = useCpuTimeoutRetry(attemptSignIn);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    runSignIn();
  };

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
              {showWarning ? (
                <CpuTimeoutWarning
                  attemptCount={attemptCount}
                  maxRetries={maxRetries}
                  hasExhaustedRetries={hasExhaustedRetries}
                  secondsUntilRetry={secondsUntilRetry}
                />
              ) : (
                error && <div className="text-sm text-error">{error}</div>
              )}
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
                  className="font-medium text-base-content hover:underline"
                >
                  Sign up
                </Link>
              </p>
              <p className="text-sm text-base-content/60">
                <Link
                  to="/forgot-password"
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
