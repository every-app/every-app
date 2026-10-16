import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { CircleAlert } from "lucide-react";
import { authClient } from "@/client/auth-client";
import {
  AuthCard,
  AuthPageShell,
  authInputClassName,
  authSubmitClassName,
} from "@/client/components/auth/AuthPageShell";
import { CodeBlock } from "@/client/components/CodeBlock";
import { CpuTimeoutWarning } from "@/client/components/CpuTimeoutWarning";
import { useAppForm } from "@/client/components/form/useAppForm";
import { PageLoading } from "@/client/components/Spinner";
import { Alert, AlertDescription } from "@/client/components/ui/alert";
import { Button } from "@/client/components/ui/button";
import { useCpuTimeoutRetry } from "@/client/hooks/useCpuTimeoutRetry";
import { claimGateway, readSetupToken } from "@/client/setup-link";
import { refetchCollectionsAfterAuth } from "@/client/tanstack-db";
import { hasOwner } from "@/serverFunctions/admin";

export const Route = createFileRoute("/setup")({
  component: Setup,
});

const claimSchema = z
  .object({
    name: z.string().trim().min(1, "Enter your name."),
    email: z.string().trim().email("Enter a valid email address."),
    password: z.string().min(8, "Password must be at least 8 characters"),
    confirmPassword: z.string(),
  })
  .refine((value) => value.password === value.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

/**
 * Claim a freshly deployed gateway with the one-time link the CLI printed
 * (`/setup#token=est_…`). The token is read from the fragment once, kept only
 * in memory, and the address bar is reset to `/setup` straight away.
 */
function Setup() {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const { data: ownerData, isLoading } = useQuery({
    queryKey: ["hasOwner"],
    queryFn: () => hasOwner(),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  useEffect(() => {
    // Keep a token already read: React's StrictMode runs this effect twice in
    // development, and by the second run the fragment is gone.
    const fromHash = readSetupToken(window.location.hash);
    setToken((current) => current ?? fromHash);
    if (window.location.hash) {
      window.history.replaceState(null, "", "/setup");
    }
  }, []);

  if (isLoading || token === undefined) return <PageLoading />;

  if (ownerData?.hasOwner) {
    return (
      <AuthPageShell>
        <AuthCard
          title="Gateway already set up"
          description="This gateway already has an owner."
        >
          <Button
            nativeButton={false}
            className={authSubmitClassName}
            render={<Link to="/sign-in" />}
          >
            Sign in
          </Button>
        </AuthCard>
      </AuthPageShell>
    );
  }

  if (!token) {
    return (
      <AuthPageShell>
        <AuthCard title="Setup link required" size="md">
          <p className="text-sm text-muted-foreground">
            Open the setup link that was printed when this gateway was deployed,
            or create a new one on the machine that deployed it:
          </p>
          <CodeBlock
            code="everyapp gateway claim-link"
            successMessage="Command copied"
          />
        </AuthCard>
      </AuthPageShell>
    );
  }

  return <ClaimForm token={token} />;
}

function ClaimForm({ token }: { token: string }) {
  const [error, setError] = useState("");
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const finish = async () => {
    await queryClient.invalidateQueries({ queryKey: ["hasOwner"] });
    navigate({ to: "/" });
  };

  const form = useAppForm({
    defaultValues: { name: "", email: "", password: "", confirmPassword: "" },
    validators: { onSubmit: claimSchema },
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
    const { name, email, password } = form.state.values;
    const result = await claimGateway({ token, name, email, password });
    if (!result.ok) {
      if (result.retry) return false;
      setError(result.message);
      return true;
    }

    const { error: signInError } = await authClient.signIn.email({
      email,
      password,
    });
    if (signInError) {
      navigate({ to: "/sign-in" });
      return true;
    }
    await queryClient.refetchQueries({ queryKey: ["auth", "session"] });
    refetchCollectionsAfterAuth();
    if (hadRetries) {
      setRetrySuccess();
    } else {
      await finish();
    }
    return true;
  });

  if (showWarning || isRetrySuccess) {
    return (
      <CpuTimeoutWarning
        attemptCount={attemptCount}
        maxRetries={maxRetries}
        hasExhaustedRetries={hasExhaustedRetries}
        secondsUntilRetry={secondsUntilRetry}
        isSuccess={isRetrySuccess}
        onContinue={() => void finish()}
      />
    );
  }

  return (
    <AuthPageShell>
      <AuthCard
        title="Set up your gateway"
        description="Create the owner account for this gateway."
      >
        <form.AppForm>
          <form.Form className="space-y-4">
            <form.AppField name="name">
              {(field) => (
                <field.TextField
                  label="Name"
                  placeholder="Your name"
                  autoComplete="name"
                  className={authInputClassName}
                  maxLength={120}
                  disabled={isRunning}
                  required
                />
              )}
            </form.AppField>
            <form.AppField name="email">
              {(field) => (
                <field.TextField
                  label="Email"
                  type="email"
                  placeholder="you@example.com"
                  autoComplete="email"
                  className={authInputClassName}
                  disabled={isRunning}
                  required
                />
              )}
            </form.AppField>
            <form.AppField name="password">
              {(field) => (
                <field.TextField
                  label="Password"
                  description="Password must be at least 8 characters"
                  type="password"
                  placeholder="Create a password"
                  autoComplete="new-password"
                  className={authInputClassName}
                  maxLength={128}
                  disabled={isRunning}
                  required
                />
              )}
            </form.AppField>
            <form.AppField name="confirmPassword">
              {(field) => (
                <field.TextField
                  label="Confirm password"
                  type="password"
                  placeholder="Confirm your password"
                  autoComplete="new-password"
                  className={authInputClassName}
                  maxLength={128}
                  disabled={isRunning}
                  required
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
              {isRunning ? "Setting up..." : "Create owner account"}
            </Button>
          </form.Form>
        </form.AppForm>
      </AuthCard>
    </AuthPageShell>
  );
}
