import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { CircleAlert, CircleCheck } from "lucide-react";
import { authClient, isCpuTimeoutError } from "@/client/auth-client";
import {
  AuthCard,
  AuthPageShell,
  authInputClassName,
  authLinkClassName,
  authSubmitClassName,
} from "@/client/components/auth/AuthPageShell";
import { CpuTimeoutWarning } from "@/client/components/CpuTimeoutWarning";
import { useAppForm } from "@/client/components/form/useAppForm";
import { Alert, AlertDescription } from "@/client/components/ui/alert";
import { Button } from "@/client/components/ui/button";
import { useCpuTimeoutRetry } from "@/client/hooks/useCpuTimeoutRetry";
import { getServerErrorMessage } from "@/client/errors";

const searchSchema = z.object({
  token: z.string().optional().catch(undefined),
  error: z.string().optional().catch("invalid"),
  redirect: z.string().optional().catch(undefined),
  return_to: z.string().optional().catch(undefined),
});

const resetPasswordSchema = z
  .object({
    newPassword: z.string().min(8, "Password must be at least 8 characters."),
    confirmPassword: z.string(),
  })
  .refine((value) => value.newPassword === value.confirmPassword, {
    message: "Passwords don't match.",
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

/** Whether the link can be used at all: it carries a token and no error. */
function isLinkUsable(token: string | undefined, urlError: string | undefined) {
  return Boolean(token) && !urlError;
}

export const Route = createFileRoute("/reset-password")({
  component: ResetPassword,
  validateSearch: searchSchema,
});

function ResetPassword() {
  const { token, error: urlError, redirect, return_to } = Route.useSearch();
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  // The server refused the token: the form can't succeed, so it gives way.
  const [tokenRefused, setTokenRefused] = useState(false);
  const navigate = useNavigate();
  const authSearch = getAuthSearch({ redirect, return_to });
  const linkUsable = isLinkUsable(token, urlError) && !tokenRefused;

  // The form only renders when the link carries a token and no error.
  const form = useAppForm({
    defaultValues: { newPassword: "", confirmPassword: "" },
    validators: { onSubmit: resetPasswordSchema },
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
    try {
      const { error: resetError } = await authClient.resetPassword({
        token: token ?? "",
        newPassword: form.state.values.newPassword,
      });

      if (resetError) {
        if (resetError.code === "INVALID_TOKEN") {
          setTokenRefused(true);
          return true;
        }
        setError("Couldn't reset your password. Please try again.");
        return true;
      }

      if (hadRetries) {
        setRetrySuccess();
      } else {
        setSuccess(true);
        setTimeout(
          () =>
            navigate({
              to: "/sign-in",
              search: authSearch,
            }),
          2000,
        );
      }
      return true;
    } catch (err) {
      if (isCpuTimeoutError(err)) {
        return false;
      }
      setError(
        getServerErrorMessage(
          err,
          "Couldn't reset your password. Please try again.",
        ),
      );
      return true;
    }
  });

  // Show the retry status while retrying or once retries are exhausted
  if (showWarning || isRetrySuccess) {
    return (
      <CpuTimeoutWarning
        attemptCount={attemptCount}
        maxRetries={maxRetries}
        hasExhaustedRetries={hasExhaustedRetries}
        secondsUntilRetry={secondsUntilRetry}
        isSuccess={isRetrySuccess}
        onContinue={() =>
          navigate({
            to: "/sign-in",
            search: authSearch,
          })
        }
      />
    );
  }

  const footer = (
    <p>
      <Link to="/sign-in" search={authSearch} className={authLinkClassName}>
        Back to sign in
      </Link>
    </p>
  );

  if (success) {
    return (
      <AuthPageShell>
        <AuthCard title="Password updated" footer={footer}>
          <Alert variant="success">
            <CircleCheck />
            <AlertDescription>
              Your password is updated. Taking you to sign in…
            </AlertDescription>
          </Alert>
        </AuthCard>
      </AuthPageShell>
    );
  }

  if (!linkUsable) {
    return (
      <AuthPageShell>
        <AuthCard
          title="Reset link not valid"
          description="Ask for a new one."
          footer={footer}
        >
          <Button
            nativeButton={false}
            className={authSubmitClassName}
            render={<Link to="/forgot-password" search={authSearch} />}
          >
            Request a new reset link
          </Button>
        </AuthCard>
      </AuthPageShell>
    );
  }

  return (
    <AuthPageShell>
      <AuthCard title="Reset password" footer={footer}>
        <form.AppForm>
          <form.Form className="space-y-4">
            <form.AppField name="newPassword">
              {(field) => (
                <field.TextField
                  label="New password"
                  type="password"
                  placeholder="Enter new password"
                  autoComplete="new-password"
                  className={authInputClassName}
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
                  placeholder="Confirm new password"
                  autoComplete="new-password"
                  className={authInputClassName}
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
              Reset password
            </Button>
          </form.Form>
        </form.AppForm>
      </AuthCard>
    </AuthPageShell>
  );
}
