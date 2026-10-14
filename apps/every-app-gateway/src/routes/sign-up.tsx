import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { authClient, isCpuTimeoutError } from "@/client/auth-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { refetchCollectionsAfterAuth } from "@/client/tanstack-db";
import { CpuTimeoutWarning } from "@/client/components/CpuTimeoutWarning";
import { useCpuTimeoutRetry } from "@/client/hooks/useCpuTimeoutRetry";
import { useSignInMethods } from "@/client/sign-in-methods";
import { hasOwner } from "@/serverFunctions/admin";
import { getSafeRedirect, getSafeReturnTo, isWorkerRoute } from "@/utils/auth";

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

export const Route = createFileRoute("/sign-up")({
  component: SignUp,
  validateSearch: searchSchema,
});

function SignUp() {
  const { redirect, return_to } = Route.useSearch();
  const invitationToken = extractInvitationTokenFromRedirect(redirect);
  const isInvitationFlow = Boolean(invitationToken);
  const { data: ownerData, isLoading: isCheckingOwner } = useQuery({
    queryKey: ["hasOwner"],
    queryFn: () => hasOwner(),
    // Prevent background refetches from switching views during retry success screen
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const { data: methods } = useSignInMethods();

  if (isCheckingOwner) {
    return null;
  }

  // With password sign-in off, an invited person signs in with Cloudflare
  // Access instead; that accepts the invitation for their verified email.
  if (isInvitationFlow && methods && !methods.emailPassword) {
    return (
      <SignInWithAccessInstead redirect={redirect} return_to={return_to} />
    );
  }

  if (isInvitationFlow) {
    return (
      <CreateInvitedAccountForm
        redirect={redirect}
        return_to={return_to}
        invitationToken={invitationToken!}
      />
    );
  }

  if (!ownerData?.hasOwner) {
    return <SetupPending redirect={redirect} return_to={return_to} />;
  }

  return <InvitationRequired redirect={redirect} return_to={return_to} />;
}

function CreateInvitedAccountForm({
  redirect,
  return_to,
  invitationToken,
}: {
  redirect?: string;
  return_to?: string;
  invitationToken: string;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const safeRedirect = getSafeRedirect(redirect);

  const continueToDestination = () => {
    const safeReturnTo = getSafeReturnTo(return_to);
    if (safeReturnTo) {
      window.location.assign(safeReturnTo);
    } else if (isWorkerRoute(safeRedirect)) {
      window.location.assign(safeRedirect);
    } else {
      navigate({ to: safeRedirect });
    }
  };

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
      const { error: signUpError } = await authClient.signUp.email(
        {
          email,
          password,
          name: email.split("@")[0] || "",
        },
        {
          // The invite link's secret: sign-up is refused without it.
          query: { invitationToken },
        },
      );

      if (signUpError) {
        setError(signUpError.message || "Failed to create account.");
        return true;
      }

      await queryClient.refetchQueries({ queryKey: ["auth", "session"] });
      refetchCollectionsAfterAuth();

      if (hadRetries) {
        setRetrySuccess();
      } else {
        continueToDestination();
      }

      return true;
    } catch (err) {
      if (isCpuTimeoutError(err)) {
        return false;
      }
      setError(
        err instanceof Error
          ? err.message
          : "Failed to create account. Please try again.",
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

  if (showWarning || isRetrySuccess) {
    return (
      <CpuTimeoutWarning
        attemptCount={attemptCount}
        maxRetries={maxRetries}
        hasExhaustedRetries={hasExhaustedRetries}
        secondsUntilRetry={secondsUntilRetry}
        isSuccess={isRetrySuccess}
        onContinue={continueToDestination}
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
            <h2 className="card-title">Create Account</h2>
            <p>Create your account to join the invited organization</p>

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
                {isRunning ? "Creating account..." : "Create Account"}
              </button>
            </form>

            <div className="flex justify-center mt-4">
              <p className="text-sm text-base-content/60">
                Already have an account?{" "}
                <Link
                  to="/sign-in"
                  search={getAuthSearch({ redirect, return_to })}
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
 * Shown until the gateway has an owner. Nobody can sign up on an unclaimed
 * gateway: its owner is created from the one-time setup link the deployer's
 * CLI printed.
 */
function SetupPending({
  redirect,
  return_to,
}: {
  redirect?: string;
  return_to?: string;
}) {
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
            <h2 className="card-title justify-center">Setup pending</h2>
            <p className="text-base-content/70 mt-2">
              This gateway hasn&apos;t been claimed yet. Open the setup link
              that was printed when it was deployed, or create a new one on the
              machine that deployed it:
            </p>
            <code className="block mt-3 text-sm">
              everyapp gateway claim-link
            </code>

            <div className="divider">OR</div>

            <p className="text-sm text-base-content/60">
              Already have an account?{" "}
              <Link
                to="/sign-in"
                search={getAuthSearch({ redirect, return_to })}
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

/** Invited, with password sign-in off: Cloudflare Access is the way in. */
function SignInWithAccessInstead({
  redirect,
  return_to,
}: {
  redirect?: string;
  return_to?: string;
}) {
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
            <h2 className="card-title justify-center">Sign in to join</h2>
            <p className="text-base-content/70 mt-2">
              This gateway doesn&apos;t use passwords. Sign in with your invited
              email through Cloudflare Access, and you&apos;ll join
              automatically.
            </p>
            <div className="mt-4">
              <Link
                to="/sign-in"
                search={getAuthSearch({ redirect, return_to })}
                className="btn btn-primary"
              >
                Sign in
              </Link>
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
function InvitationRequired({
  redirect,
  return_to,
}: {
  redirect?: string;
  return_to?: string;
}) {
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
              administrator to request an invitation email.
            </p>

            <div className="divider">OR</div>

            <p className="text-sm text-base-content/60">
              Already have an account?{" "}
              <Link
                to="/sign-in"
                search={getAuthSearch({ redirect, return_to })}
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

function extractInvitationTokenFromRedirect(redirect?: string): string | null {
  if (!redirect || !redirect.startsWith("/accept-invitation")) {
    return null;
  }

  const queryIndex = redirect.indexOf("?");
  if (queryIndex < 0) {
    return null;
  }

  const searchParams = new URLSearchParams(redirect.slice(queryIndex + 1));
  return searchParams.get("token") || null;
}
