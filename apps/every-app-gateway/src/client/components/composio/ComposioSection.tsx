import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { COMPOSIO_IS } from "@every-app/sdk/internal";
import { authClient } from "@/client/auth-client";
import { HowComposioWorks } from "@/client/components/composio/HowComposioWorks";
import { TurnOnComposioDialog } from "@/client/components/composio/TurnOnComposioDialog";
import { ConfirmDialog } from "@/client/components/ConfirmDialog";
import { SettingsSection } from "@/client/components/SettingsLayout";
import { Button, buttonVariants } from "@/client/components/ui/button";
import { getRuleErrorMessage } from "@/client/errors";
import {
  COMPOSIO_STATUS_KEY,
  useComposioStatus,
} from "@/client/hooks/useComposio";
import {
  ComposioLinkStep,
  useComposioLink,
} from "@/client/hooks/useComposioLink";
import { CONNECTED_ACCOUNTS_KEY } from "@/client/hooks/useConnectedAccounts";
import { setComposioSwitch, unlinkComposio } from "@/serverFunctions/composio";

/** The confirm that is open. */
enum Asking {
  /** An owner or admin links while Composio is off: turning it on comes first. */
  TurnOn = "turn-on",
  Unlink = "unlink",
}

/**
 * Composio on Your connections → Accounts
 * (docs/design/2026-11-composio.md): linking the person's own Composio,
 * and unlinking it. Link Composio opens the sign-in at Composio in a new
 * tab, and the section waits for the approval in place. Until it is
 * linked, the section links to the page on how it works. Linking adds no
 * connection: an account there becomes one when an app asks for it.
 *
 * Shown while Composio is on for the organization, and to an owner or
 * admin while it is off, whose first step then turns it on. It reads its
 * own status, so Connected accounts doesn't wait for it.
 */
export function ComposioSection() {
  const queryClient = useQueryClient();
  const { data: status } = useComposioStatus();
  const { data: member } = authClient.useActiveMemberRole();
  const canTurnOn = member?.role === "owner" || member?.role === "admin";
  const [asking, setAsking] = useState<Asking | null>(null);
  const link = useComposioLink({
    onLinked: () =>
      queryClient.invalidateQueries({ queryKey: COMPOSIO_STATUS_KEY }),
  });
  const unlinkMutation = useMutation({
    mutationFn: () => unlinkComposio(),
    onSuccess: async () => {
      // The connections made through it went with it.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: COMPOSIO_STATUS_KEY }),
        queryClient.invalidateQueries({ queryKey: CONNECTED_ACCOUNTS_KEY }),
      ]);
      toast.success("Composio unlinked");
    },
    onError: (error) =>
      toast.error(getRuleErrorMessage(error, "Failed to unlink Composio")),
  });

  if (!status) return null;
  const off = status.composio === "off";
  if (!status.linked && off && !canTurnOn) return null;

  const turnOnAndLink = () =>
    link.start(async () => {
      await setComposioSwitch({ data: { on: true } });
      // The switch decides what every list on screen says.
      void queryClient.invalidateQueries();
    });

  const waiting =
    link.progress?.step === ComposioLinkStep.Waiting ? link.progress : null;
  // What the section says, and its one action, by where the link stands.
  const view = status.linked
    ? {
        hint: `Linked as ${status.account}.`,
        action: (
          <Button variant="outline" onClick={() => setAsking(Asking.Unlink)}>
            Unlink
          </Button>
        ),
      }
    : waiting
      ? {
          hint: "Approve the sign-in at Composio.",
          // For a browser that opened no tab, or a tab the person closed.
          // A real link, so no popup blocker stops it.
          action: (
            <a
              href={waiting.url}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ variant: "outline" })}
            >
              Open Composio
            </a>
          ),
        }
      : {
          hint:
            link.progress?.step === ComposioLinkStep.Expired ? (
              "The sign-in expired."
            ) : (
              <>
                {COMPOSIO_IS} <HowComposioWorks />
              </>
            ),
          action: (
            <Button
              pending={link.starting}
              onClick={() => (off ? setAsking(Asking.TurnOn) : link.start())}
            >
              Link Composio
            </Button>
          ),
        };

  return (
    <>
      <SettingsSection title="Composio" hint={view.hint} action={view.action}>
        {null}
      </SettingsSection>

      {asking === Asking.TurnOn ? (
        <TurnOnComposioDialog
          confirmLabel="Turn on and link"
          onClose={() => setAsking(null)}
          onConfirm={() => {
            // At the click, so the sign-in's tab opens.
            turnOnAndLink();
            setAsking(null);
          }}
        />
      ) : null}

      {asking === Asking.Unlink ? (
        <ConfirmDialog
          title="Unlink Composio?"
          confirmLabel="Unlink"
          destructive
          pending={unlinkMutation.isPending}
          onClose={() => setAsking(null)}
          onConfirm={() =>
            unlinkMutation.mutate(undefined, {
              onSettled: () => setAsking(null),
            })
          }
        >
          The connections you made through Composio are deleted.
        </ConfirmDialog>
      ) : null}
    </>
  );
}
