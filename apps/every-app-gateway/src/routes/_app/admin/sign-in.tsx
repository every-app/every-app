import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { SignInProviderSetupDialog } from "@/client/components/admin/SignInProviderSetupDialog";
import { ErrorState } from "@/client/components/ErrorState";
import { SectionHeader } from "@/client/components/PageHeader";
import { Badge } from "@/client/components/ui/badge";
import { Button } from "@/client/components/ui/button";
import { Skeleton } from "@/client/components/ui/skeleton";
import {
  SIGN_IN_LEAD,
  passwordSignInView,
  signInStatusView,
  type ListedSignInProvider,
} from "@/client/lib/signInProviders";
import { listSignInProviders } from "@/serverFunctions/signin";

export const Route = createFileRoute("/_app/admin/sign-in")({
  component: SignInPage,
});

const SIGN_IN_PROVIDERS_KEY = ["admin", "signInProviders"] as const;

/**
 * Manage workspace → Sign-in: the ways people sign in beside their
 * password (Google, Microsoft, GitHub, Apple, Cloudflare, an OIDC issuer),
 * each on, off, or needing setup, with a dialog that says what to make at
 * the provider, the redirect URL, which settings are set (never a value)
 * and the command that sets them. Read-only by design: the settings are
 * Worker secrets the Gateway can't write to itself, so a stolen admin
 * session can't add a way in (threat model B10).
 */
function SignInPage() {
  const [open, setOpen] = useState<ListedSignInProvider | null>(null);
  const query = useQuery({
    queryKey: SIGN_IN_PROVIDERS_KEY,
    queryFn: () => listSignInProviders(),
  });
  const listing = query.data;
  // Reopen from the live list, so a refetch shows the new state.
  const shown = open
    ? (listing?.providers.find((provider) => provider.id === open.id) ?? open)
    : null;

  return (
    <div className="space-y-6">
      <SectionHeader title="Sign-in" hint={SIGN_IN_LEAD} />

      {query.isError ? (
        <ErrorState
          message="Couldn't load the sign-in providers."
          onRetry={() => void query.refetch()}
          isRetrying={query.isFetching}
        />
      ) : !listing ? (
        <div className="space-y-2" aria-busy>
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-12 w-full" />
          ))}
        </div>
      ) : (
        <ul
          className="divide-y divide-border rounded-lg border border-border"
          aria-label="Ways to sign in"
        >
          <PasswordRow password={listing.password} />
          {listing.access.on && listing.access.label ? (
            <Row
              name={`Cloudflare Access (${listing.access.label})`}
              detail={
                <>
                  Set with{" "}
                  <span className="font-mono">pnpm everyapp access on</span>
                </>
              }
              status={<span>On</span>}
            />
          ) : null}
          {listing.providers.map((provider) => (
            <ProviderRow
              key={provider.id}
              provider={provider}
              onOpen={() => setOpen(provider)}
            />
          ))}
        </ul>
      )}

      {shown ? (
        <SignInProviderSetupDialog
          provider={shown}
          // On the hosted gateway the platform's operator holds the
          // Cloudflare login; on a self-hosted one an owner or admin may.
          canRun={listing?.operator !== "hosted"}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
  );
}

function Row({
  name,
  detail,
  status,
  action,
}: {
  name: ReactNode;
  detail?: ReactNode;
  status: ReactNode;
  action?: ReactNode;
}) {
  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm font-medium">{name}</p>
        {detail ? (
          <p className="text-xs text-muted-foreground">{detail}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-3 text-sm">
        {status}
        {action}
      </div>
    </li>
  );
}

function PasswordRow({
  password,
}: {
  password: Parameters<typeof passwordSignInView>[0];
}) {
  const view = passwordSignInView(password);
  return (
    <Row
      name="Password"
      detail={view.note}
      status={
        <span className={view.label === "Off" ? "text-muted-foreground" : ""}>
          {view.label}
        </span>
      }
    />
  );
}

function ProviderRow({
  provider,
  onOpen,
}: {
  provider: ListedSignInProvider;
  onOpen: () => void;
}) {
  const view = signInStatusView(provider);
  const name = `Continue with ${provider.label}`;
  if (provider.status === "incomplete") {
    return (
      <Row
        name={name}
        detail={provider.problem}
        status={
          <button
            type="button"
            onClick={onOpen}
            className="cursor-pointer rounded-4xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            aria-label={`${provider.label}: needs setup`}
          >
            <Badge variant="warning">Needs setup</Badge>
          </button>
        }
      />
    );
  }
  return (
    <Row
      name={name}
      status={
        <span
          className={provider.status === "off" ? "text-muted-foreground" : ""}
        >
          {view.label}
        </span>
      }
      action={
        <Button
          variant={provider.status === "off" ? "outline" : "ghost"}
          size="sm"
          onClick={onOpen}
          aria-label={`${view.action}: ${provider.label}`}
        >
          {view.action}
        </Button>
      }
    />
  );
}
