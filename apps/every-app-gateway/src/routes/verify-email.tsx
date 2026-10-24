import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { CircleAlert, CircleCheck } from "lucide-react";
import { authClient } from "@/client/auth-client";
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
import { useSession } from "@/client/hooks/useSession";
import { refetchCollectionsAfterAuth } from "@/client/tanstack-db";
import { verifyEmailCallbackURL } from "@/client/verify-email";
import { getSafeRedirect, getSafeReturnTo, isWorkerRoute } from "@/utils/auth";

/**
 * Where a hosted account verifies its email (accounts sign in only once
 * they have): sign-up sends people here to check their inbox, a refused
 * sign-in sends them here to ask for a new link, and the link itself comes
 * back here, signed in, on its way to where they were going. Better Auth
 * adds `error` when the link was expired or invalid.
 */
// Each value falls back rather than failing the route: a stray `?error=1`
// (a number to the router) used to crash the page.
const searchSchema = z.object({
  email: z.string().optional().catch(undefined),
  redirect: z.string().optional().catch(undefined),
  return_to: z.string().optional().catch(undefined),
  error: z.string().optional().catch("invalid"),
});

const resendSchema = z.object({
  email: z.string().trim().email("Enter a valid email address."),
});

// The server allows a few resends a minute per client and a few a day per
// address; the button waits this long between them.
const RESEND_COOLDOWN_SECONDS = 60;

function authSearch({
  redirect,
  return_to,
}: {
  redirect?: string;
  return_to?: string;
}) {
  const search: { redirect?: string; return_to?: string } = {};
  if (redirect) search.redirect = redirect;
  if (return_to) search.return_to = return_to;
  return redirect || return_to ? search : undefined;
}

export const Route = createFileRoute("/verify-email")({
  component: VerifyEmail,
  validateSearch: searchSchema,
});

function VerifyEmail() {
  const { email, redirect, return_to, error } = Route.useSearch();
  const session = useSession();
  const navigate = useNavigate();
  const safeRedirect = getSafeRedirect(redirect);
  const verified = Boolean(session.data?.user?.emailVerified);

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

  // Back from the link, signed in: on to where they were going.
  const continued = useRef(false);
  useEffect(() => {
    if (continued.current || !session.isFetchedAfterMount || !verified) return;
    continued.current = true;
    refetchCollectionsAfterAuth();
    continueToDestination();
  }, [session.isFetchedAfterMount, verified]);

  if (verified) {
    return (
      <AuthPageShell>
        <AuthCard title="Email verified">
          <Alert variant="success">
            <CircleCheck />
            <AlertDescription>Your email address is verified.</AlertDescription>
          </Alert>
          <Button
            className={authSubmitClassName}
            onClick={continueToDestination}
          >
            Continue
          </Button>
        </AuthCard>
      </AuthPageShell>
    );
  }

  return (
    <AuthPageShell>
      <AuthCard
        title={
          error
            ? "Link not valid"
            : email
              ? "Check your email"
              : "Verify your email"
        }
        description={
          error
            ? "That link expired or was replaced. Ask for a new one."
            : email
              ? `We sent a link to ${email}. Open it to sign in.`
              : undefined
        }
        footer={
          <p>
            Already verified?{" "}
            <Link
              to="/sign-in"
              search={authSearch({ redirect, return_to })}
              className={authLinkClassName}
            >
              Sign in
            </Link>
          </p>
        }
      >
        <ResendForm
          email={email}
          callbackURL={verifyEmailCallbackURL({ redirect, return_to })}
        />
      </AuthCard>
    </AuthPageShell>
  );
}

function ResendForm({
  email,
  callbackURL,
}: {
  email?: string;
  callbackURL: string;
}) {
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const form = useAppForm({
    defaultValues: { email: email ?? "" },
    validators: { onSubmit: resendSchema },
    onSubmitInvalid: () => setError(""),
    onSubmit: async ({ value }) => {
      setError("");
      setSent(false);
      setSending(true);
      try {
        const { error: resendError } = await authClient.sendVerificationEmail({
          email: value.email.trim(),
          callbackURL,
        });
        if (resendError) {
          setError(
            resendError.status === 429
              ? "Too many requests. Wait a minute and try again."
              : "Couldn't send a new link. Please try again.",
          );
          return;
        }
        setSent(true);
        setCooldown(RESEND_COOLDOWN_SECONDS);
      } catch {
        setError("Couldn't send a new link. Please try again.");
      } finally {
        setSending(false);
      }
    },
  });

  return (
    <form.AppForm>
      <form.Form className="space-y-4">
        {/* The address is in the title's line when it is known. */}
        {email ? null : (
          <form.AppField name="email">
            {(field) => (
              <field.TextField
                label="Email"
                type="email"
                placeholder="you@example.com"
                autoComplete="email"
                className={authInputClassName}
                disabled={sending}
                required
              />
            )}
          </form.AppField>
        )}
        {sent ? (
          <Alert variant="success">
            <CircleCheck />
            <AlertDescription>
              If that account still needs verifying, we sent it a new link.
            </AlertDescription>
          </Alert>
        ) : null}
        {error ? (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <Button
          type="submit"
          className={authSubmitClassName}
          pending={sending}
          disabled={cooldown > 0}
        >
          {cooldown > 0 ? `Send a new link (${cooldown}s)` : "Send a new link"}
        </Button>
      </form.Form>
    </form.AppForm>
  );
}
