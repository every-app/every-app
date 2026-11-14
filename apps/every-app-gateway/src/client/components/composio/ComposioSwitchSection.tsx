import { useState } from "react";
import { HowComposioWorks } from "@/client/components/composio/HowComposioWorks";
import { TurnOnComposioDialog } from "@/client/components/composio/TurnOnComposioDialog";
import { ConfirmDialog } from "@/client/components/ConfirmDialog";
import { SettingsSection } from "@/client/components/SettingsLayout";
import { Badge } from "@/client/components/ui/badge";
import { Button } from "@/client/components/ui/button";
import { useComposioSwitch, useSetComposio } from "@/client/hooks/useComposio";

/** What turning Composio off deletes, counted. */
function turnOffText({
  links,
  connections,
}: {
  links: number;
  connections: number;
}): string {
  const deleted = [
    links > 0
      ? `${links} ${links === 1 ? "person's Composio link" : "people's Composio links"}`
      : null,
    connections > 0
      ? `${connections} ${connections === 1 ? "connection" : "connections"} made through Composio`
      : null,
  ].filter((part) => part !== null);
  return `This deletes ${deleted.join(" and ")}.`;
}

/**
 * Composio on Manage workspace → Providers, above the providers
 * (docs/design/2026-11-composio.md): the organization's switch, On or
 * Off, with Turn on behind a confirm, and Turn off behind one while it
 * would delete anything, which the server decides: an unconfirmed Turn
 * off that would delete comes back with the counts to ask about. It is
 * not a provider, so it is no row of their table. Nothing until the
 * switch is read; the page reads fine without it. Owners and admins.
 */
export function ComposioSwitchSection() {
  const { data: status } = useComposioSwitch();
  const mutation = useSetComposio();
  // The confirm that is open: turning it on, or off with what that deletes.
  const [asking, setAsking] = useState<
    "on" | { links: number; connections: number } | null
  >(null);
  if (!status) return null;
  const on = status.composio === "on";
  const close = () => setAsking(null);

  return (
    <>
      <SettingsSection
        title={
          <span className="flex items-center gap-2">
            Composio
            <Badge variant={on ? "success" : "outline"}>
              {on ? "On" : "Off"}
            </Badge>
          </span>
        }
        hint={
          <>
            Gateway users can optionally use Composio to link their accounts.{" "}
            <HowComposioWorks />
          </>
        }
        action={
          <Button
            variant="outline"
            pending={mutation.isPending}
            onClick={() =>
              on
                ? mutation.mutate(
                    { on: false },
                    {
                      onSuccess: (result) => {
                        if ("needsConfirm" in result) {
                          setAsking(result.needsConfirm);
                        }
                      },
                    },
                  )
                : setAsking("on")
            }
          >
            {on ? "Turn off" : "Turn on"}
          </Button>
        }
      >
        {null}
      </SettingsSection>

      {asking === "on" ? (
        <TurnOnComposioDialog
          pending={mutation.isPending}
          onClose={close}
          onConfirm={() => mutation.mutate({ on: true }, { onSettled: close })}
        />
      ) : asking ? (
        <ConfirmDialog
          title="Turn off Composio?"
          confirmLabel="Turn off"
          destructive
          pending={mutation.isPending}
          onClose={close}
          onConfirm={() =>
            mutation.mutate({ on: false, confirm: true }, { onSettled: close })
          }
        >
          {turnOffText(asking)}
        </ConfirmDialog>
      ) : null}
    </>
  );
}
