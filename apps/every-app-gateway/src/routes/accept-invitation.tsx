import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";
import { CircleAlert } from "lucide-react";
import { isCpuTimeoutError } from "@/client/auth-client";
import {
  AuthCard,
  AuthPageShell,
  authLinkClassName,
  authSubmitClassName,
} from "@/client/components/auth/AuthPageShell";
import { CpuTimeoutWarning } from "@/client/components/CpuTimeoutWarning";
import { PageLoading } from "@/client/components/Spinner";
import { Alert, AlertDescription } from "@/client/components/ui/alert";
import { Button } from "@/client/components/ui/button";
import { useCpuTimeoutRetry } from "@/client/hooks/useCpuTimeoutRetry";
import { useSession } from "@/client/hooks/useSession";
import { getServerErrorMessage } from "@/client/errors";
import { refetchCollectionsAfterAuth } from "@/client/tanstack-db";
import { acceptInvitation } from "@/serverFunctions/organizations";

const searchSchema = z.object({
  token: z.string().optional(),
  // Links from before invite links had their own secret carry only this.
  invitationId: z.string().optional(),
});

export const Route = createFileRoute("/accept-invitation")({
  validateSearch: searchSchema,
  component: AcceptInvitation,
});

function AcceptInvitation() {
  const { token, invitationId } = Route.useSearch();
  const session = useSession();
  const queryClient = useQueryClient();
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const navigate = useNavigate();
  const redirectTo = token
    ? `/accept-invitation?token=${encodeURIComponent(token)}`
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
      if (!token) {
        setError("Missing invitation link.");
        return true;
      }

      await acceptInvitation({ data: { token } });
      await queryClient.refetchQueries({ queryKey: ["auth", "session"] });
      void refetchCollectionsAfterAuth();

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
          // A server function sends the client only its error's message, and
          // publicErrorMiddleware lets only public messages through.
          err instanceof Error && err.message
            ? err.message
            : "Failed to accept invitation. Please try again.",
        ),
      );
      return true;
    }
  });

  if (!token) {
    return (
      <AuthPageShell>
        <AuthCard title="Invalid invitation">
          <p className="text-sm text-muted-foreground">
            {invitationId
              ? "This invitation link no longer works: invite links changed in a gateway update. Ask the person who invited you to send you a new link."
              : "This invitation link is invalid or incomplete. Please request a new invitation from the administrator."}
          </p>
          <Button
            nativeButton={false}
            className={authSubmitClassName}
            render={<Link to="/sign-in" />}
          >
            Go to sign in
          </Button>
        </AuthCard>
      </AuthPageShell>
    );
  }

  if (session.isPending) {
    return <PageLoading />;
  }

  if (!session.data?.user) {
    return (
      <AuthPageShell>
        <AuthCard title="Sign in required">
          <p className="text-sm text-muted-foreground">
            Please sign in or create an account with your invited email to
            accept this invitation.
          </p>
          <div className="space-y-2">
            <Button
              nativeButton={false}
              className={authSubmitClassName}
              render={<Link to="/sign-in" search={{ redirect: redirectTo }} />}
            >
              Sign in
            </Button>
            <Button
              nativeButton={false}
              variant="ghost"
              className="w-full"
              render={<Link to="/sign-up" search={{ redirect: redirectTo }} />}
            >
              Create account
            </Button>
          </div>
        </AuthCard>
      </AuthPageShell>
    );
  }

  if (success) {
    return (
      <AuthPageShell>
        <AuthCard title="Invitation accepted">
          <p className="text-sm text-muted-foreground">
            You have joined the organization successfully.
          </p>
          <Button
            nativeButton={false}
            className={authSubmitClassName}
            render={<Link to="/" />}
          >
            Go to gateway
          </Button>
        </AuthCard>
      </AuthPageShell>
    );
  }

  const handleJoin = () => {
    setError("");
    executeWithRetry();
  };

  // Show the retry status while retrying or once retries are exhausted
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
    <AuthPageShell>
      <AuthCard
        title="Accept invitation"
        description="Join your organization workspace."
        footer={
          <p>
            Already have an account?{" "}
            <Link to="/sign-in" className={authLinkClassName}>
              Sign in
            </Link>
          </p>
        }
      >
        {error ? (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <Button
          className={authSubmitClassName}
          pending={isRunning}
          onClick={handleJoin}
        >
          {isRunning ? "Joining..." : "Join organization"}
        </Button>
      </AuthCard>
    </AuthPageShell>
  );
}
