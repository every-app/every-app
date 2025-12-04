import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useState } from "react";
import { authClient, CpuTimeoutError } from "@/client/auth-client";
import { useQueryClient } from "@tanstack/react-query";
import { CpuTimeoutWarning } from "@/components/CpuTimeoutWarning";

export const Route = createFileRoute("/sign-up")({
  component: SignUp,
});

function SignUp() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [isCpuTimeout, setIsCpuTimeout] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

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
      const { error: signUpError } = await authClient.signUp.email({
        email,
        password,
        name: "",
      });

      if (signUpError) {
        setError(signUpError.message || "Failed to sign up. Please try again.");
        setLoading(false);
      } else {
        await queryClient.invalidateQueries({ queryKey: ["auth", "session"] });
        await queryClient.invalidateQueries({ queryKey: ["user-apps"] });
        navigate({ to: "/" });
      }
    } catch (err) {
      console.error("Sign up error:", err);
      if (err instanceof CpuTimeoutError) {
        setIsCpuTimeout(true);
        setError(err.message);
      } else {
        setError(
          err instanceof Error
            ? err.message
            : "Failed to sign up. Please try again.",
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
            <h2 className="card-title">Sign Up</h2>
            <p>Create a new account to get started</p>

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
              {error &&
                (isCpuTimeout ? (
                  <CpuTimeoutWarning />
                ) : (
                  <div className="text-sm text-error">{error}</div>
                ))}
              <button
                type="submit"
                className="btn btn-primary w-full"
                disabled={loading}
              >
                {loading ? "Creating account..." : "Sign Up"}
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
