import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { CircleAlert } from "lucide-react";
import { authClient, isCpuTimeoutError } from "@/client/auth-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { refetchCollectionsAfterAuth } from "@/client/tanstack-db";
import { CodeBlock } from "@/client/components/CodeBlock";
import { CpuTimeoutWarning } from "@/client/components/CpuTimeoutWarning";
import { PageLoading } from "@/client/components/Spinner";
import {
  AuthCard,
  AuthPageShell,
  authInputClassName,
  authLinkClassName,
  authSubmitClassName,
} from "@/client/components/auth/AuthPageShell";
import { useAppForm } from "@/client/components/form/useAppForm";
import { Alert, AlertDescription } from "@/client/components/ui/alert";
import { Button } from "@/client/components/ui/button";
import { useCpuTimeoutRetry } from "@/client/hooks/useCpuTimeoutRetry";
import { useSignInMethods } from "@/client/sign-in-methods";
import { hasOwner } from "@/serverFunctions/admin";
import { getSafeRedirect, getSafeReturnTo, isWorkerRoute } from "@/utils/auth";

const searchSchema = z.object({
  redirect: z.string().optional(),
  return_to: z.string().optional(),
});

const createAccountSchema = z
  .object({
    email: z.string().trim().email("Enter a valid email address."),
    password: z.string().min(8, "Password must be at least 8 characters."),
    confirmPassword: z.string(),
  })
  .refine((value) => value.password === value.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
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
    return <PageLoading />;
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

  // The schema checks the fields, matching passwords included. The sign-up
  // runs in `executeWithRetry`, which retries on a CPU timeout, so it reads
  // the values from the form each try.
  const form = useAppForm({
    defaultValues: { email: "", password: "", confirmPassword: "" },
    validators: { onSubmit: createAccountSchema },
    // Every submit clears the last server error, a refused one included.
    onSubmitInvalid: () => setError(""),
    onSubmit: () => {
      setError("");
      executeWithRetry();
    },
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
    // Trimmed as the browser trims a type="email" input's value.
    const email = form.state.values.email.trim();
    const { password } = form.state.values;
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
    <AuthPageShell>
      <AuthCard
        title="Create account"
        description="Create your account to join the invited organization."
        footer={<SignInInstead redirect={redirect} return_to={return_to} />}
      >
        <form.AppForm>
          <form.Form className="space-y-4">
            <form.AppField name="email">
              {(field) => (
                <field.TextField
                  label="Email"
                  type="email"
                  placeholder="you@example.com"
                  className={authInputClassName}
                  autoComplete="email"
                  required
                  disabled={isRunning}
                />
              )}
            </form.AppField>
            <form.AppField name="password">
              {(field) => (
                <field.TextField
                  label="Password"
                  type="password"
                  placeholder="Create a password"
                  className={authInputClassName}
                  autoComplete="new-password"
                  required
                  minLength={8}
                  disabled={isRunning}
                />
              )}
            </form.AppField>
            <form.AppField name="confirmPassword">
              {(field) => (
                <field.TextField
                  label="Confirm password"
                  type="password"
                  placeholder="Confirm your password"
                  className={authInputClassName}
                  autoComplete="new-password"
                  required
                  minLength={8}
                  disabled={isRunning}
                />
              )}
            </form.AppField>
            {error ? (
              <Alert variant="destructive">
                <CircleAlert />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            <Button
              type="submit"
              className={authSubmitClassName}
              pending={isRunning}
            >
              {isRunning ? "Creating account..." : "Create account"}
            </Button>
          </form.Form>
        </form.AppForm>
      </AuthCard>
    </AuthPageShell>
  );
}

/** "Already have an account? Sign in", below the card. */
function SignInInstead({
  redirect,
  return_to,
}: {
  redirect?: string;
  return_to?: string;
}) {
  return (
    <p>
      Already have an account?{" "}
      <Link
        to="/sign-in"
        search={getAuthSearch({ redirect, return_to })}
        className={authLinkClassName}
      >
        Sign in
      </Link>
    </p>
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
    <AuthPageShell>
      <AuthCard
        title="Setup pending"
        footer={<SignInInstead redirect={redirect} return_to={return_to} />}
      >
        <p className="text-sm text-muted-foreground">
          This gateway hasn&apos;t been claimed yet. Open the setup link that
          was printed when it was deployed, or create a new one on the machine
          that deployed it:
        </p>
        <CodeBlock
          code="everyapp gateway claim-link"
          successMessage="Command copied"
        />
      </AuthCard>
    </AuthPageShell>
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
    <AuthPageShell>
      <AuthCard title="Sign in to join">
        <p className="text-sm text-muted-foreground">
          This gateway doesn&apos;t use passwords. Sign in with your invited
          email through Cloudflare Access, and you&apos;ll join automatically.
        </p>
        <Button
          className={authSubmitClassName}
          nativeButton={false}
          render={
            <Link
              to="/sign-in"
              search={getAuthSearch({ redirect, return_to })}
            />
          }
        >
          Sign in
        </Button>
      </AuthCard>
    </AuthPageShell>
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
    <AuthPageShell>
      <AuthCard
        title="Invitation required"
        footer={<SignInInstead redirect={redirect} return_to={return_to} />}
      >
        <p className="text-sm text-muted-foreground">
          This gateway uses invite-only registration. Please contact the
          administrator to request an invitation email.
        </p>
      </AuthCard>
    </AuthPageShell>
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
