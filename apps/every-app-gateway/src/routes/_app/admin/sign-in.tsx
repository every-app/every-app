import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Info } from "lucide-react";
import { SignInProviderSetupDialog } from "@/client/components/admin/SignInProviderSetupDialog";
import { ErrorState } from "@/client/components/ErrorState";
import {
  SettingsList,
  SettingsListSkeleton,
  SettingsRow,
  SettingsSection,
  SettingsTab,
} from "@/client/components/SettingsLayout";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/client/components/ui/alert";
import { Badge } from "@/client/components/ui/badge";
import { Button } from "@/client/components/ui/button";
import {
  OUTER_RING_BANNER,
  OUTER_RING_DETAIL,
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
 *
 * With Cloudflare Access in front (the outer ring), Access signs people in
 * and the providers only matter without it: a banner says so, and the
 * providers that are off fold behind one row. One that is on or needs
 * setup stays out, so nothing configured hides.
 */
function SignInPage() {
  const [open, setOpen] = useState<ListedSignInProvider | null>(null);
  const [showAll, setShowAll] = useState(false);
  const query = useQuery({
    queryKey: SIGN_IN_PROVIDERS_KEY,
    queryFn: () => listSignInProviders(),
  });
  const listing = query.data;
  // Reopen from the live list, so a refetch shows the new state.
  const shown = open
    ? (listing?.providers.find((provider) => provider.id === open.id) ?? open)
    : null;
  const outerRing = listing?.outerRing ?? false;
  const folded =
    outerRing && !showAll
      ? (listing?.providers.filter((provider) => provider.status === "off") ??
        [])
      : [];
  const listed =
    listing?.providers.filter((provider) => !folded.includes(provider)) ?? [];

  return (
    <SettingsTab>
      <SettingsSection title="Sign-in">
        {outerRing ? (
          <Alert variant="info" role="note">
            <Info />
            <AlertTitle>{OUTER_RING_BANNER.title}</AlertTitle>
            <AlertDescription>{OUTER_RING_BANNER.description}</AlertDescription>
          </Alert>
        ) : null}

        {query.isError ? (
          <ErrorState
            message="Couldn't load the sign-in providers."
            onRetry={() => void query.refetch()}
            isRetrying={query.isFetching}
          />
        ) : !listing ? (
          <SettingsListSkeleton rows={4} />
        ) : (
          <SettingsList label="Ways to sign in">
            {outerRing ? (
              <SettingsRow
                name="Cloudflare Access"
                detail={
                  <>
                    {OUTER_RING_DETAIL}{" "}
                    <span className="font-mono">pnpm everyapp access on</span>
                  </>
                }
                status={<span>On</span>}
              />
            ) : null}
            <PasswordRow password={listing.password} outerRing={outerRing} />
            {listing.access.on && listing.access.label ? (
              <SettingsRow
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
            {listed.map((provider) => (
              <ProviderRow
                key={provider.id}
                provider={provider}
                onOpen={() => setOpen(provider)}
              />
            ))}
            {folded.length > 0 ? (
              <SettingsRow
                name="Sign-in providers"
                detail={`${folded.map((provider) => provider.label).join(", ")}: off`}
                action={
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowAll(true)}
                  >
                    Show sign-in providers
                  </Button>
                }
              />
            ) : null}
          </SettingsList>
        )}
      </SettingsSection>

      {shown ? (
        <SignInProviderSetupDialog
          provider={shown}
          // On the hosted gateway the platform's operator holds the
          // Cloudflare login; on a self-hosted one an owner or admin may.
          canRun={listing?.operator !== "hosted"}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </SettingsTab>
  );
}

function PasswordRow({
  password,
  outerRing,
}: {
  password: Parameters<typeof passwordSignInView>[0];
  outerRing: boolean;
}) {
  const view = passwordSignInView(password, { outerRing });
  return (
    <SettingsRow
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
      <SettingsRow
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
    <SettingsRow
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
