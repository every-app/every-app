import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";
import { CircleAlert } from "lucide-react";
import { isCpuTimeoutError } from "@/client/auth-client";
import {
  AuthCard,
  AuthPageShell,
  authSubmitClassName,
} from "@/client/components/auth/AuthPageShell";
import { CpuTimeoutWarning } from "@/client/components/CpuTimeoutWarning";
import { PageLoading } from "@/client/components/Spinner";
import { Alert, AlertDescription } from "@/client/components/ui/alert";
import { Button } from "@/client/components/ui/button";
import { useCpuTimeoutRetry } from "@/client/hooks/useCpuTimeoutRetry";
import { useSession } from "@/client/hooks/useSession";
import { getServerErrorMessage } from "@/client/errors";
import { lookupInvitation } from "@/client/invitation-link";
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
  // Who is invited where, before sign-in: null once the gateway refuses the
  // link. On a failed lookup (rate limited, offline) `data` stays undefined
  // and the page falls back to the plain sign-in card.
  const invitation = useQuery({
    queryKey: ["invitation", "peek", token],
    queryFn: () => lookupInvitation(token!),
    enabled: Boolean(token),
    // The key carries the link's secret: memory only, never localStorage.
    meta: { persist: false },
    // One lookup per token for the page's life: the shared client refetches
    // on every mount by default (queryClient.ts), and accepting consumes the
    // token. A failed lookup (no data) is still retried on the next mount.
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 1,
  });

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
        setError("This invitation link is not valid.");
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
            : "Couldn't accept the invitation. Please try again.",
        ),
      );
      return true;
    }
  });

  // Links from before invite links had their own secret, and links the
  // gateway refuses (unknown, used, canceled, expired), end the same way:
  // the person needs a new one. Signed out, this comes before sign-in, so
  // nobody makes an account for a dead link. Signed in, the server decides
  // on Join instead (see below).
  const notValid = (
    <AuthPageShell>
      <AuthCard
        title="Invitation link not valid"
        description="Ask the person who invited you for a new one."
      >
        <Button
          nativeButton={false}
          className={authSubmitClassName}
          render={<Link to="/sign-in" />}
        >
          Back to sign in
        </Button>
      </AuthCard>
    </AuthPageShell>
  );
  if (!token) return notValid;

  if (invitation.isPending) {
    return <PageLoading />;
  }

  // Accepting consumes the token, so these come before the dead-link check.
  if (success) {
    return (
      <AuthPageShell>
        <AuthCard title="Invitation accepted">
          <Button
            nativeButton={false}
            className={authSubmitClassName}
            render={<Link to="/" />}
          >
            Continue
          </Button>
        </AuthCard>
      </AuthPageShell>
    );
  }

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

  const organizationName = invitation.data?.organizationName;

  if (session.isPending) {
    return <PageLoading />;
  }

  if (!session.data?.user) {
    if (invitation.data === null) return notValid;
    return (
      <AuthPageShell>
        <AuthCard
          title={
            organizationName
              ? `You're invited to ${organizationName}`
              : "Sign in to accept"
          }
          description={
            invitation.data
              ? `Sign in or create an account as ${invitation.data.invitedEmail} to accept.`
              : "Use the email address that was invited."
          }
        >
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
              variant="outline"
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

  const handleJoin = () => {
    setError("");
    executeWithRetry();
  };

  // Signed in, a dead lookup does not end the page: behind the Access outer
  // ring the session check itself accepts a pending invitation for the
  // verified address (ensureAccessMembership), after which the lookup says
  // 404 while the link still confirms for that person
  // (InvitationService.accept). A truly dead token surfaces as the alert
  // on Join, as it always has.
  return (
    <AuthPageShell>
      <AuthCard
        title={
          organizationName ? `Join ${organizationName}` : "Accept invitation"
        }
        description={`Signed in as ${session.data.user.email}`}
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
          Join organization
        </Button>
      </AuthCard>
    </AuthPageShell>
  );
}
