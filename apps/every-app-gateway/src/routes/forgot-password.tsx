import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { CircleAlert, CircleCheck } from "lucide-react";
import { authClient, isCpuTimeoutError } from "@/client/auth-client";
import {
  AuthCard,
  AuthPageShell,
  NoEmailResetNotice,
  authInputClassName,
  authLinkClassName,
  authSubmitClassName,
} from "@/client/components/auth/AuthPageShell";
import { CpuTimeoutWarning } from "@/client/components/CpuTimeoutWarning";
import { useAppForm } from "@/client/components/form/useAppForm";
import { Alert, AlertDescription } from "@/client/components/ui/alert";
import { Button } from "@/client/components/ui/button";
import { useCpuTimeoutRetry } from "@/client/hooks/useCpuTimeoutRetry";
import { useSignInMethods } from "@/client/sign-in-methods";
import {
  getBetterAuthErrorMessage,
  getServerErrorMessage,
} from "@/client/errors";

const searchSchema = z.object({
  redirect: z.string().optional(),
  return_to: z.string().optional(),
});

const forgotPasswordSchema = z.object({
  email: z.string().trim().email("Enter a valid email address."),
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

export const Route = createFileRoute("/forgot-password")({
  component: ForgotPassword,
  validateSearch: searchSchema,
});

function ForgotPassword() {
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const navigate = useNavigate();
  const { redirect, return_to } = Route.useSearch();
  const authSearch = getAuthSearch({ redirect, return_to });
  const { data: methods } = useSignInMethods();
  // Unknown while the methods load (or if they can't): the form stays.
  const emailOff = methods?.emailConfigured === false;

  const form = useAppForm({
    defaultValues: { email: "" },
    validators: { onSubmit: forgotPasswordSchema },
    onSubmit: () => {
      setError("");
      setSuccess(false);
      runForgotPassword();
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
    executeWithRetry: runForgotPassword,
  } = useCpuTimeoutRetry(async () => {
    try {
      const resetPasswordUrl = new URL(
        "/reset-password",
        window.location.origin,
      );
      if (redirect) {
        resetPasswordUrl.searchParams.set("redirect", redirect);
      }
      if (return_to) {
        resetPasswordUrl.searchParams.set("return_to", return_to);
      }

      const { error: resetError } = await authClient.requestPasswordReset({
        email: form.state.values.email,
        redirectTo: resetPasswordUrl.toString(),
      });

      if (resetError) {
        setError(
          getBetterAuthErrorMessage(resetError, "Failed to send reset email."),
        );
        return true;
      }
      if (hadRetries) {
        setRetrySuccess();
      } else {
        setSuccess(true);
      }
      return true;
    } catch (err) {
      console.error("Password reset error:", err);
      if (isCpuTimeoutError(err)) {
        return false;
      }
      setError(
        getServerErrorMessage(
          err,
          "Failed to send reset email. Please try again.",
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

  return (
    <AuthPageShell>
      <AuthCard
        title={success ? "Check your email" : "Forgot password"}
        description={
          success || emailOff
            ? undefined
            : "We'll email you a link to reset it."
        }
        footer={
          success ? undefined : (
            <p>
              Remember your password?{" "}
              <Link
                to="/sign-in"
                search={authSearch}
                className={authLinkClassName}
              >
                Sign in
              </Link>
            </p>
          )
        }
      >
        {success ? (
          <>
            <Alert variant="success">
              <CircleCheck />
              <AlertDescription>
                If an account exists for this email, we sent a password reset
                link.
              </AlertDescription>
            </Alert>
            <Button
              nativeButton={false}
              className={authSubmitClassName}
              render={<Link to="/sign-in" search={authSearch} />}
            >
              Back to sign in
            </Button>
          </>
        ) : emailOff ? (
          <NoEmailResetNotice />
        ) : (
          <form.AppForm>
            <form.Form className="space-y-4">
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
                Send reset link
              </Button>
            </form.Form>
          </form.AppForm>
        )}
      </AuthCard>
    </AuthPageShell>
  );
}
