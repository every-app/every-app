import { useId, useState, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { COMPOSIO_IS } from "@every-app/sdk/internal";
import { COMPOSIO_FIELDS, ComposioPageStep } from "@/schemas/composio";
import type { ComposioPageContext } from "@/server/composio/connect";
import { AppIcon } from "@/client/components/AppIcon";
import { BrandMark } from "@/client/components/BrandLink";
import { ProviderIcon } from "@/client/components/ProviderIcon";
import { Button, buttonVariants } from "@/client/components/ui/button";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/client/components/ui/native-select";
import {
  ComposioLinkStep,
  useComposioLink,
} from "@/client/hooks/useComposioLink";
import { namesText } from "@/client/lib/oauthProviders";
import {
  ComposioAllowsNote,
  ConsentBox,
  ConsentCard,
  ConsentHeader,
  ConsentRow,
  DecisionButtons,
  SignedInRow,
  useSendOnce,
} from "./consentParts";
import { useDeliberateAllow } from "./useDeliberateAllow";

type OkContext = Extract<ComposioPageContext, { ok: true }>;
type StepContext<Step extends ComposioPageStep> = Extract<
  OkContext,
  { step: Step }
>;

interface ComposioFormProps {
  context: OkContext;
  onSwitchAccount?: () => void;
  /** Loads the context again: after the person linked, or connected a service in Composio. */
  onReload: () => Promise<unknown>;
}

/**
 * The Composio page (docs/design/2026-11-composio.md): an app asks to use
 * an account from the person's Composio, for a provider this Gateway
 * holds no client for. By what the person has to do next: sign in to
 * Composio, which waits for the approval and then loads the page again;
 * connect a service the app needs in Composio, then check again; or
 * allow, a native form posting the one-use state, the decision and one
 * account per service to `/connect/<provider>/composio`, which checks
 * them again.
 */
export function ComposioForm({
  context,
  onSwitchAccount,
  onReload,
}: ComposioFormProps) {
  switch (context.step) {
    case ComposioPageStep.Link:
      return (
        <LinkStep
          context={context}
          onSwitchAccount={onSwitchAccount}
          onReload={onReload}
        />
      );
    case ComposioPageStep.Missing:
      return (
        <MissingStep
          context={context}
          onSwitchAccount={onSwitchAccount}
          onReload={onReload}
        />
      );
    case ComposioPageStep.Allow:
      return <AllowStep context={context} onSwitchAccount={onSwitchAccount} />;
  }
}

/** What every step shows: the app and the provider, the step's title, one line under it, who is signed in, then the step's own part. */
function StepCard({
  context,
  title,
  line,
  onSwitchAccount,
  children,
}: {
  context: OkContext;
  title: string;
  line: string | null;
  onSwitchAccount?: () => void;
  children: ReactNode;
}) {
  return (
    <ConsentCard>
      <BrandMark className="justify-center" />

      <ConsentHeader
        from={<AppIcon app={context.app} />}
        to={<ProviderIcon provider={context.provider} />}
        title={title}
      >
        {line ? (
          <p className="mt-2 text-sm text-pretty text-muted-foreground">
            {line}
          </p>
        ) : null}
      </ConsentHeader>

      <div className="space-y-4">
        <SignedInRow email={context.email} onSwitchAccount={onSwitchAccount} />
        {children}
      </div>
    </ConsentCard>
  );
}

function LinkStep({
  context,
  onSwitchAccount,
  onReload,
}: ComposioFormProps & { context: StepContext<ComposioPageStep.Link> }) {
  const link = useComposioLink({ onLinked: onReload });
  return (
    <div className="w-full max-w-md">
      <StepCard
        context={context}
        title={`Sign in to Composio to use your ${context.provider.name} account in ${context.app.name}`}
        line={COMPOSIO_IS}
        onSwitchAccount={onSwitchAccount}
      >
        {link.progress?.step === ComposioLinkStep.Waiting ? (
          <div className="flex flex-col gap-2">
            <p className="text-center text-sm text-muted-foreground">
              Approve the sign-in at Composio.
            </p>
            {/* For a browser that opened no tab, or a tab the person closed.
                A real link, so no popup blocker stops it. */}
            <a
              href={link.progress.url}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ variant: "outline" })}
            >
              Open Composio
            </a>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {link.progress?.step === ComposioLinkStep.Expired ? (
              <p className="text-center text-sm text-muted-foreground">
                The sign-in expired.
              </p>
            ) : null}
            <Button pending={link.starting} onClick={() => link.start()}>
              Sign in to Composio
            </Button>
          </div>
        )}
      </StepCard>
    </div>
  );
}

function MissingStep({
  context,
  onSwitchAccount,
  onReload,
}: ComposioFormProps & { context: StepContext<ComposioPageStep.Missing> }) {
  const [checking, setChecking] = useState(false);
  const one = context.missing.length === 1;
  const check = async () => {
    setChecking(true);
    try {
      await onReload();
    } finally {
      setChecking(false);
    }
  };
  return (
    <div className="w-full max-w-md">
      <StepCard
        context={context}
        title={`${namesText(context.missing.map((service) => service.label))} ${one ? "isn't" : "aren't"} connected in your Composio`}
        line={`${context.app.name} needs ${one ? "it" : "them"}.`}
        onSwitchAccount={onSwitchAccount}
      >
        <div className="flex flex-col gap-2">
          {context.missing.map((service) => (
            <a
              key={service.slug}
              href={service.url}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ variant: "outline" })}
            >
              Connect {service.label} in Composio
              <ExternalLink data-icon="inline-end" aria-hidden />
            </a>
          ))}
          <Button pending={checking} onClick={() => void check()}>
            Check again
          </Button>
        </div>
      </StepCard>
    </div>
  );
}

type AllowService = StepContext<ComposioPageStep.Allow>["services"][number];

/** One service the app would use, with its account: a choice where the person has several there. */
function ServiceRow({ service }: { service: AllowService }) {
  const id = useId();
  const name = COMPOSIO_FIELDS.account(service.slug);
  if (service.accounts.length > 1) {
    return (
      <ConsentRow label={service.label} htmlFor={id} control>
        <NativeSelect
          id={id}
          name={name}
          className="w-full"
          defaultValue={service.chosen}
        >
          {service.accounts.map((account) => (
            <NativeSelectOption key={account.id} value={account.id}>
              {account.account}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </ConsentRow>
    );
  }
  return (
    <ConsentRow label={service.label}>
      <input type="hidden" name={name} value={service.chosen} />
      {service.accounts[0]?.account}
    </ConsentRow>
  );
}

function AllowStep({
  context,
  onSwitchAccount,
}: {
  context: StepContext<ComposioPageStep.Allow>;
  onSwitchAccount?: () => void;
}) {
  const { app, provider, services } = context;
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
      <input type="hidden" name={COMPOSIO_FIELDS.state} value={context.state} />

      <StepCard
        context={context}
        title={`Allow ${app.name} to use your ${provider.name} account from Composio?`}
        line={context.why}
        onSwitchAccount={onSwitchAccount}
      >
        <ConsentBox>
          {services.map((service) => (
            <ServiceRow key={service.slug} service={service} />
          ))}
        </ConsentBox>

        <ComposioAllowsNote app={app.name} accounts={services.length} />

        <DecisionButtons
          sentDecision={sentDecision}
          canAllow={deliberate}
          denyLabel="Don't allow"
        />
      </StepCard>
    </form>
  );
}
