import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { authClient, isCpuTimeoutError } from "@/client/auth-client";
import { CpuTimeoutWarning } from "@/client/components/CpuTimeoutWarning";
import { useCpuTimeoutRetry } from "@/client/hooks/useCpuTimeoutRetry";
import { useSession } from "@/client/hooks/useSession";
import { getServerErrorMessage } from "@/client/errors";

const searchSchema = z.object({
  invitationId: z.string().optional(),
});

export const Route = createFileRoute("/accept-invitation")({
  validateSearch: searchSchema,
  component: AcceptInvitation,
});

function AcceptInvitation() {
  const { invitationId } = Route.useSearch();
  const session = useSession();
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const navigate = useNavigate();
  const redirectTo = invitationId
    ? `/accept-invitation?invitationId=${encodeURIComponent(invitationId)}`
    : "/accept-invitation";

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
      if (!invitationId) {
        setError("Missing invitation ID.");
        return true;
      }

      const { error: acceptError } =
        await authClient.organization.acceptInvitation({
          invitationId,
        });

      if (acceptError) {
        setError(acceptError.message || "Failed to accept invitation.");
        return true;
      }

      if (hadRetries) {
        setRetrySuccess();
      } else {
        setSuccess(true);
      }
      return true;
    } catch (err) {
      if (isCpuTimeoutError(err)) {
        return false;
      }
      setError(
        getServerErrorMessage(
          err,
          "Failed to accept invitation. Please try again.",
        ),
      );
      return true;
    }
  });

  if (!invitationId) {
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
                This invitation link is invalid or missing an invitation ID.
                Please request a new invitation from the administrator.
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

  if (!session.isPending && !session.data?.user) {
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
              <h2 className="card-title justify-center">Sign in Required</h2>
              <p className="text-base-content/70 mt-2">
                Please sign in or create an account with your invited email to
                accept this invitation.
              </p>
              <div className="mt-4 flex gap-2 justify-center">
                <Link
                  to="/sign-in"
                  search={{ redirect: redirectTo }}
                  className="btn btn-primary"
                >
                  Sign In
                </Link>
                <Link
                  to="/sign-up"
                  search={{ redirect: redirectTo }}
                  className="btn btn-outline"
                >
                  Create Account
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
                You have joined the organization successfully.
              </p>
              <div className="mt-4">
                <Link to="/" className="btn btn-primary">
                  Go to Gateway
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
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
        onContinue={() => navigate({ to: "/" })}
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
            <h2 className="card-title">Accept Invitation</h2>
            <p>Join your organization workspace</p>

            <form onSubmit={handleSubmit}>
              {error && <div className="text-sm text-error">{error}</div>}
              <button
                type="submit"
                className="btn btn-primary w-full"
                disabled={isRunning}
              >
                {isRunning ? "Joining..." : "Join Organization"}
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
