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
        , then paste its client ID and secret.
      </p>
      <CodeBlock code={redirectUri} successMessage="Redirect URI copied" />
    </section>
  );
}

/** A preset's hint, its `backticked` words as code. */
export function HintText({ text }: { text: string }) {
  return text.split("`").map((part, index) =>
    index % 2 === 1 ? (
      <code key={index} className="font-mono text-[0.92em]">
        {part}
      </code>
    ) : (
      part
    ),
  );
}
