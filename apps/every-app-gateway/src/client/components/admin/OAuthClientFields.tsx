import { ExternalLink } from "lucide-react";
import { CodeBlock } from "@/client/components/CodeBlock";

/**
 * The part every OAuth client dialog shares (docs/design/2026-10-oauth-providers.md
 * section 4): the redirect URI to register at the provider's console, with
 * a copy button, and the console link. The fields themselves are the
 * form's (client id, client secret) so each dialog keeps its own schema.
 */
export function RedirectUriSection({
  redirectUri,
  console: consoleUrl,
  providerName,
}: {
  redirectUri: string;
  console: string | null;
  providerName: string;
}) {
  return (
    <section className="flex flex-col gap-2">
      <p className="text-sm">
        Register this redirect URI on the OAuth app
        {consoleUrl ? (
          <>
            {" at "}
            <a
              href={consoleUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 underline underline-offset-3 hover:text-foreground"
            >
              {providerName}
              <ExternalLink className="size-3.5" aria-hidden />
            </a>
          </>
        ) : (
          ` at ${providerName}`
        )}
        , then paste its client id and secret.
      </p>
      <CodeBlock code={redirectUri} successMessage="Redirect URI copied" />
    </section>
  );
}

/** The terminal alternative, for a provider whose settings have names. */
export function TerminalAlternative({
  settings,
}: {
  settings: { clientId: string; clientSecret: string | null };
}) {
  const names = [settings.clientId, settings.clientSecret]
    .filter((name): name is string => Boolean(name))
    .join(" ");
  return (
    <p className="text-xs text-muted-foreground">
      From a terminal instead:{" "}
      <span className="font-mono">pnpm everyapp secret set {names}</span> (a
      secret set there wins over one pasted here).
    </p>
  );
}
