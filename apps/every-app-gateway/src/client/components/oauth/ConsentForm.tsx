import { useState } from "react";
import { ArrowLeftRight, BadgeCheck, Send, ShieldAlert } from "lucide-react";
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
import {
  FieldDescription,
  FieldLegend,
  FieldSet,
} from "@/client/components/ui/field";
import { domainCoversRedirect } from "./clientSite";
import {
  Choice,
  DecisionButtons,
  initials,
  SignedInRow,
  useSendOnce,
} from "./consentParts";
import { useDeliberateAllow } from "./useDeliberateAllow";

type Context = Extract<ConsentContext, { ok: true }>;
type ToolState = Context["organizations"][number]["apps"][number]["tools"];

/** Beside an app that can't be chosen because it serves no tools. */
function toolHint(tools: ToolState): string | undefined {
  return tools === "none" ? "(no AI tools yet)" : undefined;
}

/**
 * The consent form for an AI app connecting to the gateway's /mcp: a
 * native form posting the user's choices to /oauth/consent/decision, which
 * checks them again. Everything about the client comes from the client,
 * and React escapes it; no client logo is loaded.
 */
export function ConsentForm({
  context,
  onSwitchAccount,
}: {
  context: Context;
  onSwitchAccount: () => void;
}) {
  const { client, organizations } = context;
  const deliberate = useDeliberateAllow();
  const [organizationId, setOrganizationId] = useState(
    context.defaultOrganizationId ?? "",
  );
  const [appMode, setAppMode] = useState<"all" | "selected">("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const organization = organizations.find((org) => org.id === organizationId);
  const canAllow =
    Boolean(organization) && (appMode === "all" || selected.size > 0);
  const { sentDecision, onSubmit } = useSendOnce();
  const verified = Boolean(
    client.domain && domainCoversRedirect(client.domain, client.redirectHost),
  );

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
            <img
              src="/transparent-logo.png"
              alt=""
              className="size-12 rounded-lg"
            />
          </div>
          <CardTitle className="mt-4 text-xl">
            <h1 className="line-clamp-3 break-words" title={client.name}>
              Connect {client.name} to EveryApp
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
              Named by the app itself.
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

          <div className="divide-y divide-border rounded-lg border border-border bg-muted/50 text-sm">
            <SignedInRow
              email={context.email}
              onSwitchAccount={onSwitchAccount}
            />
            <div className="flex items-center gap-3 px-3 py-2">
              <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted">
                <Send className="size-4" />
              </div>
              <p className="min-w-0 flex-1 break-words">
                Access will be sent to{" "}
                <strong className="font-medium">{client.redirectHost}</strong>.
              </p>
            </div>
          </div>

          {organizations.length === 0 ? (
            <Alert variant="warning">
              <ShieldAlert />
              <AlertDescription className="text-foreground">
                Your account isn't a member of any organization, so there is
                nothing to connect.
              </AlertDescription>
            </Alert>
          ) : (
            <>
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
                        onChange={() => {
                          setOrganizationId(org.id);
                          setSelected(new Set());
                        }}
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

              <FieldSet>
                <FieldLegend variant="label">Apps</FieldLegend>
                <div className="grid gap-2.5">
                  <Choice
                    type="radio"
                    name={CONSENT_FIELDS.appMode}
                    value="all"
                    checked={appMode === "all"}
                    onChange={() => setAppMode("all")}
                  >
                    All apps I can use, including future ones
                  </Choice>
                  <Choice
                    type="radio"
                    name={CONSENT_FIELDS.appMode}
                    value="selected"
                    checked={appMode === "selected"}
                    onChange={() => setAppMode("selected")}
                  >
                    Only these apps
                  </Choice>
                  {appMode === "selected" ? (
                    <div className="ml-6.5 grid gap-2.5 rounded-lg border border-border p-3">
                      {(organization?.apps ?? []).length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                          You don't have access to any apps here yet.
                        </p>
                      ) : null}
                      {organization?.apps.map((app) => (
                        <Choice
                          key={app.rowId}
                          type="checkbox"
                          name={CONSENT_FIELDS.appIds}
                          value={app.rowId}
                          disabled={app.tools === "none"}
                          checked={selected.has(app.rowId)}
                          onChange={(event) => {
                            const next = new Set(selected);
                            if (event.target.checked) next.add(app.rowId);
                            else next.delete(app.rowId);
                            setSelected(next);
                          }}
                          hint={toolHint(app.tools)}
                        >
                          {app.name}
                        </Choice>
                      ))}
                    </div>
                  ) : null}
                </div>
              </FieldSet>

              <FieldSet>
                <FieldLegend variant="label">Access</FieldLegend>
                {context.writeRequested ? (
                  <>
                    <div className="grid gap-2.5">
                      <Choice
                        type="radio"
                        name={CONSENT_FIELDS.access}
                        value="read"
                        defaultChecked
                      >
                        Read only
                      </Choice>
                      <Choice
                        type="radio"
                        name={CONSENT_FIELDS.access}
                        value="write"
                      >
                        Read &amp; write
                      </Choice>
                    </div>
                    {/* Write tools create or change; destructive ones (delete,
                        irreversible change) are never offered to an AI app. */}
                    <FieldDescription>
                      Read &amp; write can add and change things, never delete
                      them.
                    </FieldDescription>
                  </>
                ) : (
                  <>
                    {/* The client set its own ceiling (it asked for mcp:read
                        alone); nothing on this page raises it. */}
                    <input
                      type="hidden"
                      name={CONSENT_FIELDS.access}
                      value="read"
                    />
                    <FieldDescription>
                      Read only: this app asked to read, not to add or change
                      anything.
                    </FieldDescription>
                  </>
                )}
              </FieldSet>
            </>
          )}

          <DecisionButtons
            sentDecision={sentDecision}
            canAllow={canAllow && deliberate}
          />
        </CardContent>
      </Card>
    </form>
  );
}
