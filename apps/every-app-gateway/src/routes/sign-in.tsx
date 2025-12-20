import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useState } from "react";
import { authClient, CpuTimeoutError } from "@/client/auth-client";
import { useQueryClient } from "@tanstack/react-query";
import { refetchCollectionsAfterAuth } from "@/client/tanstack-db";
import { CpuTimeoutWarning } from "@/components/CpuTimeoutWarning";

export const Route = createFileRoute("/sign-in")({
  component: SignIn,
});

function SignIn() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [isCpuTimeout, setIsCpuTimeout] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setIsCpuTimeout(false);
    setLoading(true);

    try {
      const { error: signInError } = await authClient.signIn.email(
        {
          email,
          password,
        },
        {
          onSuccess: async () => {
            // Refetch session and collections now that we're authenticated
            await queryClient.invalidateQueries({
              queryKey: ["auth", "session"],
            });
            await refetchCollectionsAfterAuth();
            setLoading(false);
            navigate({ to: "/" });
          },
        },
      );

      if (signInError) {
        setError(signInError.message || "Invalid email or password.");
        setLoading(false);
      }
    } catch (err) {
      console.error("Sign in error:", err);
      if (err instanceof CpuTimeoutError) {
        setIsCpuTimeout(true);
      } else {
        setError(
          err instanceof Error
            ? err.message
            : "Failed to sign in. Please try again.",
        );
      }
      setLoading(false);
    }
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
                {loading ? "Signing in..." : "Sign In"}
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
