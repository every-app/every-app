import { ALLOW_FIELDS } from "@/schemas/app-access";
import type { AppAccessContext } from "@/server/oauth/appAccessConsent";
import { AppIcon } from "@/client/components/AppIcon";
import { BrandMark } from "@/client/components/BrandLink";
import { ProviderIcon } from "@/client/components/ProviderIcon";
import {
  ConsentBox,
  ConsentCard,
  ConsentHeader,
  ConsentRow,
  DecisionButtons,
  SignedInRow,
  useSendOnce,
} from "./consentParts";
import { useDeliberateAllow } from "./useDeliberateAllow";

type OkContext = Extract<AppAccessContext, { ok: true }>;

/**
 * The Allow page's form (docs/design/2026-11-oauth-one-connection.md): an
 * app asks to use the person's connection to a provider. It shows the app
 * and the provider by their icons, what the app says it does with the
 * account, the connected account and the scopes the app lists. A native
 * form posting the one-use state and the decision to
 * `/connect/<provider>/allow`, which checks them again.
 */
export function AppAccessForm({
  context,
  onSwitchAccount,
}: {
  context: OkContext;
  onSwitchAccount: () => void;
}) {
  const { app, provider, account, why, scopes } = context;
  const deliberate = useDeliberateAllow();
  const { sentDecision, onSubmit } = useSendOnce();

  return (
    <form
      method="post"
      action={context.action}
      className="w-full max-w-md"
      aria-busy={sentDecision !== null}
      onSubmit={onSubmit}
    >
      <input type="hidden" name={ALLOW_FIELDS.state} value={context.state} />

      <ConsentCard>
        <BrandMark className="justify-center" />

        <ConsentHeader
          from={<AppIcon app={app} />}
          to={<ProviderIcon provider={provider} />}
          title={`Allow ${app.name} to use your ${provider.name} account?`}
        >
          {why ? (
            <p className="mt-2 text-sm text-pretty text-muted-foreground">
              {why}
            </p>
          ) : null}
        </ConsentHeader>

        <div className="space-y-4">
          <SignedInRow
            email={context.email}
            onSwitchAccount={onSwitchAccount}
          />

          {account !== null || scopes.length > 0 ? (
            <ConsentBox>
              {account !== null ? (
                <ConsentRow label={`${provider.name} account`}>
                  {account}
                </ConsentRow>
              ) : null}
              {scopes.length > 0 ? (
                <ConsentRow label="Scopes">
                  {/* A long scope wraps inside its chip: it is never cut short. */}
                  <ul className="flex flex-wrap justify-end gap-1.5">
                    {scopes.map((scope) => (
                      <li key={scope}>
                        <code className="rounded border border-border bg-card px-1.5 py-0.5 font-mono text-xs font-normal">
                          {scope}
                        </code>
                      </li>
                    ))}
                  </ul>
                </ConsentRow>
              ) : null}
            </ConsentBox>
          ) : null}

          <DecisionButtons
            sentDecision={sentDecision}
            canAllow={deliberate}
            denyLabel="Don't allow"
          />
        </div>
      </ConsentCard>
    </form>
  );
}
