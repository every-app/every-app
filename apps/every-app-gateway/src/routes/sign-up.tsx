import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { z } from "zod";
import { authClient, isCpuTimeoutError } from "@/client/auth-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { refetchCollectionsAfterAuth } from "@/client/tanstack-db";
import { CpuTimeoutWarning } from "@/components/CpuTimeoutWarning";
import { useCpuTimeoutRetry } from "@/hooks/useCpuTimeoutRetry";
import { hasOwner, initializeOwner } from "@/serverFunctions/admin";
import { getSafeRedirect } from "@/utils/auth";
import { getServerErrorMessage } from "@/client/errors";

const searchSchema = z.object({
  redirect: z.string().optional(),
});

export const Route = createFileRoute("/sign-up")({
  component: SignUp,
  validateSearch: searchSchema,
});

function SignUp() {
  const { redirect } = Route.useSearch();
  const [showOwnerForm, setShowOwnerForm] = useState(false);
  const { data: ownerData, isLoading: isCheckingOwner } = useQuery({
    queryKey: ["hasOwner"],
    queryFn: () => hasOwner(),
    // Prevent background refetches from switching views during retry success screen
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  // Once we show the owner form, keep showing it (prevents switching to InvitationRequired
  // if hasOwner query refetches in the background during retry success screen)
  useEffect(() => {
    if (!isCheckingOwner && !ownerData?.hasOwner) {
      setShowOwnerForm(true);
    }
  }, [isCheckingOwner, ownerData?.hasOwner]);

  if (isCheckingOwner) {
    return null;
  }

  if (showOwnerForm || !ownerData?.hasOwner) {
    return <CreateOwnerForm redirect={redirect} />;
  }

  return <InvitationRequired redirect={redirect} />;
}

/**
 * Form for creating the first owner account.
 * Only shown when no owner exists in the system.
 */
function CreateOwnerForm({ redirect }: { redirect?: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const safeRedirect = getSafeRedirect(redirect);

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
      await initializeOwner({ data: { email, password } });

      const { error: signInError } = await authClient.signIn.email(
        { email, password },
        {
          onSuccess: async () => {
            await queryClient.refetchQueries({ queryKey: ["auth", "session"] });
            refetchCollectionsAfterAuth();
            if (hadRetries) {
              setRetrySuccess();
            } else {
              queryClient.invalidateQueries({ queryKey: ["hasOwner"] });
              navigate({ to: safeRedirect });
            }
          },
        },
      );

      if (signInError) {
        await queryClient.invalidateQueries({ queryKey: ["hasOwner"] });
        navigate({
          to: "/sign-in",
          search: redirect ? { redirect } : undefined,
        });
      }
      return true;
    } catch (err) {
      if (isCpuTimeoutError(err)) {
        return false;
      }
      setError(
        getServerErrorMessage(
          err,
          "Failed to create account. Please try again.",
        ),
      );
      return true;
    }
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (password !== confirmPassword) {
      setError("Passwords do not match");
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
        onContinue={() => {
          queryClient.invalidateQueries({ queryKey: ["hasOwner"] });
          navigate({ to: safeRedirect });
        }}
      />
    );
  }

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
                  placeholder="Create a password"
                  className="input input-bordered w-full"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                  disabled={isRunning}
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
                  disabled={isRunning}
                />
              </div>
              {error && <div className="text-sm text-error">{error}</div>}
              <button
                type="submit"
                className="btn btn-primary w-full"
                disabled={isRunning}
              >
                {isRunning ? "Creating account..." : "Create Admin Account"}
              </button>
            </form>

            <div className="flex justify-center mt-4">
              <p className="text-sm text-base-content/60">
                Already have an account?{" "}
                <Link
                  to="/sign-in"
                  search={redirect ? { redirect } : undefined}
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
function InvitationRequired({ redirect }: { redirect?: string }) {
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
                search={redirect ? { redirect } : undefined}
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
