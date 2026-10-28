import { useState } from "react";
import {
  ArrowLeftRight,
  BadgeCheck,
  Laptop,
  Send,
  ShieldAlert,
} from "lucide-react";
import { CONSENT_FIELDS } from "@/schemas/consent-decision";
import type { ConsentContext } from "@/server/mcp-auth/consent";
import { Alert, AlertDescription } from "@/client/components/ui/alert";
import { Badge } from "@/client/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/client/components/ui/card";
import { FieldLegend, FieldSet } from "@/client/components/ui/field";
import { domainCoversRedirect } from "./clientSite";
import {
  Choice,
  DecisionButtons,
  initials,
  SignedInRow,
  useSendOnce,
} from "./consentParts";
import { useDeliberateAllow } from "./useDeliberateAllow";

type OkContext = Extract<ConsentContext, { ok: true }>;

/** A native app's consent: its grant's resource is one app's host. */
export type NativeConsentContext = OkContext & {
  grant: Extract<OkContext["grant"], { kind: "native" }>;
};

/** Whether the request is a native app's, not an AI app's for /mcp. */
export function isNativeConsent(
  context: OkContext,
): context is NativeConsentContext {
  return context.grant.kind === "native";
}

/**
 * The consent form for a native app (a desktop or phone app) signing in to
 * one app as the person: the app variant of ConsentForm
 * (docs/design/native-sign-in.md section 6). There is nothing to choose but
 * the organization, and only for an app shared across several: the grant
 * is the one app, with everything the person can do there. It posts the
 * app's origin as `resource`, which the decision checks against the stored
 * request, as ConsentForm posts `/mcp`.
 */
export function NativeConsentForm({
  context,
  onSwitchAccount,
}: {
  context: NativeConsentContext;
  onSwitchAccount: () => void;
}) {
  const { client, organizations } = context;
  const { app } = context.grant;
  const deliberate = useDeliberateAllow();
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

      <Card>
        <CardHeader className="flex flex-col items-center text-center">
          <div aria-hidden className="flex items-center gap-3">
            <div className="grid size-12 shrink-0 place-items-center rounded-xl bg-primary/10 text-base font-semibold text-primary">
              {initials(client.name)}
            </div>
            <ArrowLeftRight className="size-4 text-muted-foreground" />
            <div className="grid size-12 shrink-0 place-items-center rounded-xl bg-muted text-base font-semibold">
              {initials(app.name)}
            </div>
          </div>
          <CardTitle className="mt-4 text-xl">
            <h1 className="line-clamp-3 break-words" title={client.name}>
              {client.name} wants to use {app.name}
            </h1>
          </CardTitle>
          {verified ? (
            <p className="mt-1 flex items-center justify-center gap-1.5 text-sm text-muted-foreground">
              <BadgeCheck className="size-4 shrink-0 text-success" />
              <span>
                Published by{" "}
                <strong className="font-medium text-foreground">
                  {client.domain}
                </strong>
              </span>
            </p>
          ) : client.domain ? null : (
            <p className="mt-1 text-sm text-muted-foreground">
              <Badge
                variant="outline"
                size="sm"
                className="mr-1.5 align-middle"
              >
                Unverified
              </Badge>
              This app chose its own name.
            </p>
          )}
        </CardHeader>

        <CardContent className="space-y-6">
          {client.domain && !verified ? (
            <Alert variant="warning">
              <ShieldAlert />
              <AlertDescription className="text-foreground">
                Its details are published on <strong>{client.domain}</strong>,
                but it sends access to <strong>{client.redirectHost}</strong>, a
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
          ) : (
            <p className="text-sm">
              It wants to use <strong>{app.name}</strong>{" "}
              <span className="text-muted-foreground">({app.hostname})</span> as
              you
              {organization ? (
                <>
                  , in <strong>{organization.name}</strong>
                </>
              ) : null}
              : everything you can do there.
            </p>
          )}

          <div className="divide-y divide-border rounded-lg border border-border bg-muted/50 text-sm">
            <SignedInRow
              email={context.email}
              onSwitchAccount={onSwitchAccount}
            />
            <div className="flex items-center gap-3 px-3 py-2">
              <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted">
                {loopback ? (
                  <Laptop className="size-4" />
                ) : (
                  <Send className="size-4" />
                )}
              </div>
              <p className="min-w-0 flex-1 break-words">
                {loopback ? (
                  <>
                    Back to the app on this computer{" "}
                    <span className="text-muted-foreground">
                      ({client.redirectHost})
                    </span>
                  </>
                ) : (
                  <>
                    Access will be sent to{" "}
                    <strong className="font-medium">
                      {client.redirectHost}
                    </strong>
                  </>
                )}
              </p>
            </div>
          </div>

          {organizations.length > 1 ? (
            <FieldSet>
              <FieldLegend variant="label">Organization</FieldLegend>
              <div className="grid gap-2.5">
                {organizations.map((org) => (
                  <Choice
                    key={org.id}
                    type="radio"
                    name={CONSENT_FIELDS.organizationId}
                    value={org.id}
                    checked={organizationId === org.id}
                    onChange={() => setOrganizationId(org.id)}
                  >
                    {org.name}
                  </Choice>
                ))}
              </div>
            </FieldSet>
          ) : (
            <input
              type="hidden"
              name={CONSENT_FIELDS.organizationId}
              value={organizationId}
            />
          )}

          <DecisionButtons
            sentDecision={sentDecision}
            canAllow={Boolean(organization) && deliberate}
            denyLabel="Don't allow"
          />
        </CardContent>
      </Card>
    </form>
  );
}
