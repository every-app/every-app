import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  authClient,
  CpuTimeoutError,
  isCpuTimeoutError,
} from "@/client/auth-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { refetchCollectionsAfterAuth } from "@/client/tanstack-db";
import { CpuTimeoutWarning } from "@/components/CpuTimeoutWarning";
import { hasOwner, initializeOwner } from "@/serverFunctions/admin";

export const Route = createFileRoute("/sign-up")({
  component: SignUp,
});

function SignUp() {
  const { data: ownerData, isLoading: isCheckingOwner } = useQuery({
    queryKey: ["hasOwner"],
    queryFn: () => hasOwner(),
  });

  if (isCheckingOwner) {
    return null;
  }

  if (ownerData?.hasOwner) {
    return <InvitationRequired />;
  }

  return <CreateOwnerForm />;
}

/**
 * Form for creating the first owner account.
 * Only shown when no owner exists in the system.
 */
function CreateOwnerForm() {
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
      await initializeOwner({
        data: {
          email,
          password,
        },
      });

      // Sign in the newly created owner
      const { error: signInError } = await authClient.signIn.email(
        {
          email,
          password,
        },
        {
          onSuccess: async () => {
            // Refetch session first and wait for it to complete
            await queryClient.refetchQueries({
              queryKey: ["auth", "session"],
            });
            // Then refetch collections in parallel (no need to wait)
            refetchCollectionsAfterAuth();
            setLoading(false);
            navigate({ to: "/" });
            // Invalidate hasOwner after navigating to prevent flicker
            queryClient.invalidateQueries({ queryKey: ["hasOwner"] });
          },
        },
      );

      // Only handle error case - success is handled in onSuccess callback
      if (signInError) {
        // Owner was created but sign-in failed, redirect to sign-in page
        await queryClient.invalidateQueries({ queryKey: ["hasOwner"] });
        navigate({ to: "/sign-in" });
      }
    } catch (err) {
      console.error("Owner creation error:", err);
      // Check for CPU timeout error - either from authClient (CpuTimeoutError instance)
      // or from server functions (error message contains CPU timeout keywords)
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (err instanceof CpuTimeoutError || isCpuTimeoutError(errorMessage)) {
        setIsCpuTimeout(true);
      } else {
        setError(
          err instanceof Error
            ? err.message
            : "Failed to create account. Please try again.",
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
            <h2 className="card-title">Create Admin Account</h2>
            <p>Set up the first administrator account for your gateway</p>

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
                {loading ? "Creating account..." : "Create Admin Account"}
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

/**
 * Message shown when an owner already exists.
 * Users must be invited to create an account.
 */
function InvitationRequired() {
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
            <h2 className="card-title justify-center">Invitation Required</h2>
            <p className="text-base-content/70 mt-2">
              This gateway uses invite-only registration. Please contact the
              administrator to request an invitation link.
            </p>

            <div className="divider">OR</div>

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
  );
}
