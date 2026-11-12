import { useId, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { CONSENT_FIELDS } from "@/schemas/consent-decision";
import type { ConsentContext } from "@/server/mcp-auth/consent";
import { AppIcon } from "@/client/components/AppIcon";
import { BrandMark } from "@/client/components/BrandLink";
import { Alert, AlertDescription } from "@/client/components/ui/alert";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/client/components/ui/native-select";
import { domainCoversRedirect } from "./clientSite";
import {
  ClientPublisher,
  ConsentBox,
  ConsentCard,
  ConsentHeader,
  ConsentRow,
  DecisionButtons,
  InitialsTile,
  SignedInRow,
  useSendOnce,
} from "./consentParts";
import { useDeliberateAllow } from "./useDeliberateAllow";

type OkContext = Extract<ConsentContext, { ok: true }>;

/**
 * A native app's consent (its grant's resource is one app's host), or
 * linked dev's (`everyapp dev --gateway` on the person's computer, the
 * Gateway's services for one app; docs/design/linked-dev.md).
 */
export type NativeConsentContext = OkContext & {
  grant: Extract<OkContext["grant"], { kind: "native" | "dev" }>;
};

/** Whether the request is a native app's or linked dev's, not an AI app's for /mcp. */
export function isNativeConsent(
  context: OkContext,
): context is NativeConsentContext {
  return context.grant.kind === "native" || context.grant.kind === "dev";
}

/**
 * The consent form for a native app (a desktop or phone app) signing in to
 * one app as the person: the app variant of ConsentForm
 * (docs/design/native-sign-in.md section 6). There is nothing to choose but
 * the organization, and only for an app shared across several: the grant
 * is the one app, with everything the person can do there, which the title
 * alone says. It posts the
 * app's origin as `resource`, which the decision checks against the stored
 * request, as ConsentForm posts `/mcp`.
 */
export function NativeConsentForm({
  context,
  onSwitchAccount,
}: {
  context: NativeConsentContext;
  onSwitchAccount?: () => void;
}) {
  const { client, organizations } = context;
  const { app } = context.grant;
  const dev = context.grant.kind === "dev";
  const deliberate = useDeliberateAllow();
  const organizationFieldId = useId();
  const { sentDecision, onSubmit } = useSendOnce();
  const [organizationId, setOrganizationId] = useState(
    context.defaultOrganizationId ?? organizations[0]?.id ?? "",
  );
  const organization = organizations.find((org) => org.id === organizationId);
  const verified = Boolean(
    client.domain && domainCoversRedirect(client.domain, client.redirectHost),
  );
  const loopback = client.redirectIsLoopback;

  return (
    <form
      method="post"
      action="/oauth/consent/decision"
      className="w-full max-w-md"
      aria-busy={sentDecision !== null}
      onSubmit={onSubmit}
    >
      <input
        type="hidden"
        name={CONSENT_FIELDS.handle}
        value={context.handle}
      />
      <input type="hidden" name={CONSENT_FIELDS.clientId} value={client.id} />
      <input
        type="hidden"
        name={CONSENT_FIELDS.redirectUri}
        value={client.redirectUri}
      />
      <input
        type="hidden"
        name={CONSENT_FIELDS.resource}
        value={context.grant.resource}
      />
      {organizations.length > 1 ? null : (
        <input
          type="hidden"
          name={CONSENT_FIELDS.organizationId}
          value={organizationId}
        />
      )}

      <ConsentCard>
        <BrandMark className="justify-center" />

        <ConsentHeader
          from={<InitialsTile name={client.name} />}
          to={
            <AppIcon
              app={{ ...app, status: "active" }}
              className="border border-border bg-card"
            />
          }
          title={
            dev
              ? `${client.name} wants to develop ${app.name} as you`
              : `${client.name} wants to use ${app.name}`
          }
        >
          <ClientPublisher domain={client.domain} verified={verified} />
        </ConsentHeader>

        {client.domain && !verified ? (
          <Alert variant="warning">
            <ShieldAlert />
            <AlertDescription className="text-foreground">
              Its details are published on <strong>{client.domain}</strong>, but
              it sends access to <strong>{client.redirectHost}</strong>, a
              different site. Continue only if you trust both.
            </AlertDescription>
          </Alert>
        ) : null}

        {organizations.length === 0 ? (
          <Alert variant="warning">
            <ShieldAlert />
            <AlertDescription className="text-foreground">
              You can't open {app.name} in any of your organizations, so there
              is nothing to allow.
            </AlertDescription>
          </Alert>
        ) : null}

        {organizations.length > 0 && dev ? (
          <div className="space-y-2 text-sm">
            <p>
              <code>everyapp dev</code> on this computer wants to use{" "}
              <strong>{app.name}</strong>'s AI, email, providers and members
              through this Gateway as you
              {organization ? (
                <>
                  , in <strong>{organization.name}</strong>
                </>
              ) : null}
              , while you develop it.
            </p>
            <p className="text-muted-foreground">
              Calls bill {organization?.name ?? "the workspace"}'s providers.
              The app's data stays on your computer. Revoke it any time under
              Your connections.
            </p>
          </div>
        ) : null}

        <div className="space-y-4">
          <SignedInRow
            email={context.email}
            onSwitchAccount={onSwitchAccount}
          />

          <ConsentBox>
            <ConsentRow label="Redirects to">
              <span title={client.redirectUri}>
                {loopback ? (
                  <>
                    This computer{" "}
                    <span className="font-normal text-muted-foreground">
                      ({client.redirectHost})
                    </span>
                  </>
                ) : (
                  client.redirectHost
                )}
              </span>
            </ConsentRow>
            {organizations.length > 1 ? (
              <ConsentRow
                label="Organization"
                htmlFor={organizationFieldId}
                control
              >
                <NativeSelect
                  id={organizationFieldId}
                  name={CONSENT_FIELDS.organizationId}
                  className="w-full"
                  value={organizationId}
                  onChange={(event) => setOrganizationId(event.target.value)}
                >
                  {organizations.map((org) => (
                    <NativeSelectOption key={org.id} value={org.id}>
                      {org.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </ConsentRow>
            ) : null}
          </ConsentBox>

          <DecisionButtons
            sentDecision={sentDecision}
            canAllow={Boolean(organization) && deliberate}
            denyLabel="Don't allow"
          />
        </div>
      </ConsentCard>
    </form>
  );
}
