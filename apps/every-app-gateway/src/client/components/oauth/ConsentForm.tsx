import { useRef, useState } from "react";
import { BadgeCheck, ShieldAlert } from "lucide-react";
import { CONSENT_FIELDS } from "@/schemas/consent-decision";
import type { ConsentContext } from "@/server/mcp-auth/consent";
import { domainCoversRedirect } from "./clientSite";
import { useDeliberateAllow } from "./useDeliberateAllow";

type Context = Extract<ConsentContext, { ok: true }>;

function initials(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "");
  return letters.join("") || "?";
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
  // One answer per page: a double-clicked button would send the form twice.
  const sent = useRef(false);
  const [sending, setSending] = useState(false);
  // Not `disabled`: a submit button disabled while its form is being sent
  // drops out of what is sent, and with it the decision.
  const sendingButton = sending ? " btn-disabled" : "";

  return (
    <main className="min-h-screen bg-base-100 grid place-items-center p-6">
      <form
        method="post"
        action="/oauth/consent/decision"
        className="w-full max-w-lg rounded-lg border border-base-300 bg-base-100 p-6 shadow-sm space-y-6"
        aria-busy={sending}
        onSubmit={(event) => {
          if (sent.current) {
            event.preventDefault();
            return;
          }
          sent.current = true;
          setSending(true);
        }}
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

        <header className="flex items-start gap-4">
          <div
            aria-hidden
            className="grid h-12 w-12 shrink-0 place-items-center rounded-md bg-primary/10 text-primary font-semibold"
          >
            {initials(client.name)}
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-bold break-words">
              Connect {client.name} to Every App
            </h1>
            {client.domain &&
            domainCoversRedirect(client.domain, client.redirectHost) ? (
              <p className="mt-1 text-sm flex items-center gap-1">
                <BadgeCheck className="h-4 w-4 text-success shrink-0" />
                <span>
                  Published by <strong>{client.domain}</strong>
                </span>
              </p>
            ) : client.domain ? (
              <p className="mt-1 text-sm flex items-start gap-1 text-warning">
                <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
                <span>
                  Its details are published on <strong>{client.domain}</strong>,
                  but it sends access to <strong>{client.redirectHost}</strong>,
                  a different site. Continue only if you trust both.
                </span>
              </p>
            ) : (
              <p className="mt-1 text-sm text-base-content/70">
                <span className="badge badge-ghost badge-sm mr-1">
                  unverified
                </span>
                This app named itself; its name is not verified.
              </p>
            )}
          </div>
        </header>

        <div className="rounded-md border border-base-300 p-4 text-sm space-y-2">
          <p>
            Access will be sent to <strong>{client.redirectHost}</strong>.
          </p>
          <p className="text-base-content/70">
            Signed in as <strong>{context.email}</strong>.{" "}
            <button type="button" className="link" onClick={onSwitchAccount}>
              Use another account
            </button>
          </p>
        </div>

        {organizations.length === 0 ? (
          <p className="alert alert-warning text-sm">
            Your account isn't a member of any organization, so there is nothing
            to connect.
          </p>
        ) : (
          <>
            {organizations.length > 1 ? (
              <fieldset className="space-y-2">
                <legend className="text-sm font-semibold mb-2">
                  Organization
                </legend>
                {organizations.map((org) => (
                  <label key={org.id} className="flex items-center gap-2">
                    <input
                      type="radio"
                      className="radio radio-sm"
                      name={CONSENT_FIELDS.organizationId}
                      value={org.id}
                      checked={organizationId === org.id}
                      onChange={() => {
                        setOrganizationId(org.id);
                        setSelected(new Set());
                      }}
                    />
                    <span>{org.name}</span>
                  </label>
                ))}
              </fieldset>
            ) : (
              <input
                type="hidden"
                name={CONSENT_FIELDS.organizationId}
                value={organizationId}
              />
            )}

            <fieldset className="space-y-2">
              <legend className="text-sm font-semibold mb-2">Apps</legend>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  className="radio radio-sm"
                  name={CONSENT_FIELDS.appMode}
                  value="all"
                  checked={appMode === "all"}
                  onChange={() => setAppMode("all")}
                />
                <span>All apps I can use, including future ones</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  className="radio radio-sm"
                  name={CONSENT_FIELDS.appMode}
                  value="selected"
                  checked={appMode === "selected"}
                  onChange={() => setAppMode("selected")}
                />
                <span>Only these apps</span>
              </label>
              {appMode === "selected" && (
                <div className="ml-6 space-y-1">
                  {(organization?.apps ?? []).length === 0 && (
                    <p className="text-sm text-base-content/60">
                      You don't have access to any apps here yet.
                    </p>
                  )}
                  {organization?.apps.map((app) => (
                    <label
                      key={app.rowId}
                      className={`flex items-center gap-2 ${app.hasTools ? "" : "opacity-50"}`}
                    >
                      <input
                        type="checkbox"
                        className="checkbox checkbox-sm"
                        name={CONSENT_FIELDS.appIds}
                        value={app.rowId}
                        disabled={!app.hasTools}
                        checked={selected.has(app.rowId)}
                        onChange={(event) => {
                          const next = new Set(selected);
                          if (event.target.checked) next.add(app.rowId);
                          else next.delete(app.rowId);
                          setSelected(next);
                        }}
                      />
                      <span>{app.name}</span>
                      {!app.hasTools && (
                        <span className="text-xs">(no AI tools yet)</span>
                      )}
                    </label>
                  ))}
                </div>
              )}
            </fieldset>

            <fieldset className="space-y-2">
              <legend className="text-sm font-semibold mb-2">Access</legend>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  className="radio radio-sm"
                  name={CONSENT_FIELDS.access}
                  value="write"
                  defaultChecked
                />
                <span>Read &amp; write</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  className="radio radio-sm"
                  name={CONSENT_FIELDS.access}
                  value="read"
                />
                <span>Read only</span>
              </label>
              <p className="text-xs text-base-content/60 flex items-start gap-1">
                <ShieldAlert className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                Deleting and other destructive actions are never available to
                connected AI apps yet.
              </p>
            </fieldset>
          </>
        )}

        <div className="flex justify-end gap-3">
          <button
            type="submit"
            name={CONSENT_FIELDS.decision}
            value="deny"
            className={`btn btn-ghost${sendingButton}`}
            aria-disabled={sending}
          >
            Deny
          </button>
          <button
            type="submit"
            name={CONSENT_FIELDS.decision}
            value="approve"
            className={`btn btn-primary${sendingButton}`}
            aria-disabled={sending}
            disabled={!canAllow || !deliberate}
          >
            Allow
          </button>
        </div>
      </form>
    </main>
  );
}
