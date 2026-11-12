import { useId, useState } from "react";
import { ShieldAlert } from "lucide-react";
import {
  CONSENT_FIELDS,
  type ConsentDecision,
} from "@/schemas/consent-decision";
import type { ConsentContext } from "@/server/mcp-auth/consent";
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
  NativeCheckbox,
  Segmented,
  SignedInRow,
  useSendOnce,
} from "./consentParts";
import { useDeliberateAllow } from "./useDeliberateAllow";

type Context = Extract<ConsentContext, { ok: true }>;
type ToolState = Context["organizations"][number]["apps"][number]["tools"];

type AppMode = ConsentDecision["app_mode"];

/** Which apps a connection reaches: all the person can use, or the ones they tick. */
const APP_MODES: readonly { value: AppMode; label: string }[] = [
  { value: "all", label: "All" },
  { value: "selected", label: "Selected" },
];

const ACCESS_LEVELS: readonly {
  value: ConsentDecision["access"];
  label: string;
}[] = [
  { value: "read", label: "Read only" },
  { value: "write", label: "Read & write" },
];

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
  const organizationFieldId = useId();
  const [organizationId, setOrganizationId] = useState(
    context.defaultOrganizationId ?? "",
  );
  const [appMode, setAppMode] = useState<AppMode>("all");
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
      {/* A member of one organization is asked nothing about it. */}
      {organizations.length === 1 ? (
        <input
          type="hidden"
          name={CONSENT_FIELDS.organizationId}
          value={organizationId}
        />
      ) : null}

      <ConsentCard>
        <ConsentHeader
          from={<InitialsTile name={client.name} />}
          to={
            <img
              src="/android-chrome-192x192.png"
              alt=""
              className="size-12 rounded-xl"
            />
          }
          title={`Connect ${client.name} to EveryApp`}
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
              Your account isn't a member of any organization, so there is
              nothing to connect.
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="space-y-4">
          <SignedInRow
            email={context.email}
            onSwitchAccount={onSwitchAccount}
          />

          <ConsentBox>
            <ConsentRow label="Redirects to">
              <span title={client.redirectUri}>{client.redirectHost}</span>
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
                  onChange={(event) => {
                    setOrganizationId(event.target.value);
                    setSelected(new Set());
                  }}
                >
                  {organizations.map((org) => (
                    <NativeSelectOption key={org.id} value={org.id}>
                      {org.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </ConsentRow>
            ) : null}
            {organizations.length > 0 ? (
              <>
                <ConsentRow label="Apps" control>
                  <Segmented
                    label="Apps"
                    name={CONSENT_FIELDS.appMode}
                    options={APP_MODES}
                    defaultValue="all"
                    onChange={setAppMode}
                  />
                </ConsentRow>
                {appMode === "selected" ? (
                  <div className="col-span-2">
                    <dt className="sr-only">Selected apps</dt>
                    <dd className="grid gap-2.5 rounded-md border border-border bg-card p-3">
                      {(organization?.apps ?? []).length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                          You don't have access to any apps here yet.
                        </p>
                      ) : null}
                      {organization?.apps.map((app) => (
                        <NativeCheckbox
                          key={app.rowId}
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
                        </NativeCheckbox>
                      ))}
                    </dd>
                  </div>
                ) : null}
                <ConsentRow label="Access" control={context.writeRequested}>
                  {context.writeRequested ? (
                    <Segmented
                      label="Access"
                      name={CONSENT_FIELDS.access}
                      options={ACCESS_LEVELS}
                      defaultValue="write"
                    />
                  ) : (
                    <>
                      {/* The client set its own ceiling (it asked for
                          mcp:read alone); nothing on this page raises it. */}
                      <input
                        type="hidden"
                        name={CONSENT_FIELDS.access}
                        value="read"
                      />
                      Read only
                    </>
                  )}
                </ConsentRow>
              </>
            ) : null}
          </ConsentBox>

          <DecisionButtons
            sentDecision={sentDecision}
            canAllow={canAllow && deliberate}
          />
        </div>
      </ConsentCard>
    </form>
  );
}
