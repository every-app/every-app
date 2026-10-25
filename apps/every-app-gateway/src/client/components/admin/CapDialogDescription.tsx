import { DialogDescription } from "@/client/components/ui/dialog";

/**
 * What a monthly cap is, said once for both cap dialogs (an app's and the
 * workspace default's): one wording, one spelling of Gateway.
 */
const MONTHLY_CAP_DESCRIPTION =
  "Provider calls per UTC month, AI providers and capabilities together. Once reached, the Gateway refuses the app's calls until the month ends or the cap is raised.";

/**
 * The built-in Cap alerts subscription an organization's first cap makes
 * (docs/design/2026-10-events-out.md, section 6), in the Events thread's
 * words; Events is the admin tab of its section 10.
 */
const CAP_ALERTS_DESCRIPTION =
  "Owners and admins are emailed at 80% and at the cap once the Gateway can send mail; change that under Manage workspace → Events.";

/** Where the longer story lives: what is counted, own keys, who bills you. */
const USAGE_DOCS_URL = "https://everyapp.com/docs/usage";

export function CapDialogDescription() {
  return (
    <DialogDescription>
      {MONTHLY_CAP_DESCRIPTION} {CAP_ALERTS_DESCRIPTION}{" "}
      <a href={USAGE_DOCS_URL} target="_blank" rel="noreferrer">
        Usage and caps
      </a>
    </DialogDescription>
  );
}
