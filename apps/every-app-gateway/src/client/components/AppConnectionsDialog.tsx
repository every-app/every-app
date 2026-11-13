import { Button } from "@/client/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/client/components/ui/dialog";
import { ConnectionAction, type ConnectionNeed } from "@/schemas/app-access";

/** Each action's words: the title when it is the only one to do, the row's note and its button. */
const COPY: Record<
  ConnectionAction,
  {
    title: (label: string, name: string) => string;
    note: (label: string) => string | null;
    button: (label: string) => string;
  }
> = {
  [ConnectionAction.Connect]: {
    title: (label, name) => `Connect ${label} to open ${name}`,
    note: () => null,
    button: (label) => `Connect ${label}`,
  },
  [ConnectionAction.Allow]: {
    title: (label, name) => `Allow ${name} to use your ${label} account`,
    note: () => null,
    button: () => "Allow",
  },
  [ConnectionAction.Reconnect]: {
    title: (label, name) => `Reconnect ${label} to open ${name}`,
    note: () => "Needs more access than your connection has.",
    button: () => "Reconnect",
  },
};

/**
 * The setup dialog for an app whose settings are all set but which needs
 * accounts of the viewer's (server/oauth/connection-needs.ts): one row per
 * provider with the button that does it. Each goes to the app's connect
 * link, which asks the provider or shows the Allow page, and comes back to
 * the app. The dialog renders from the live list (useSetupDialog), so it
 * closes by itself once nothing is needed.
 */
export function AppConnectionsDialog({
  name,
  hostname,
  connections,
  onClose,
}: {
  name: string;
  hostname: string | null;
  connections: ConnectionNeed[];
  onClose: () => void;
}) {
  const returnTo = hostname ? `https://${hostname}/` : "/";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {connections.length === 1
              ? COPY[connections[0]!.action].title(connections[0]!.label, name)
              : `Connect your accounts to open ${name}`}
          </DialogTitle>
        </DialogHeader>
        <ul className="divide-y divide-border rounded-lg border border-border">
          {connections.map((need) => {
            const note = COPY[need.action].note(need.label);
            return (
              <li
                key={need.provider}
                className="flex items-center justify-between gap-3 px-3 py-2.5"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">{need.label}</p>
                  {note ? (
                    <p className="text-xs text-muted-foreground">{note}</p>
                  ) : null}
                </div>
                <Button
                  size="sm"
                  nativeButton={false}
                  render={
                    <a
                      href={`${need.connectPath}&return=${encodeURIComponent(returnTo)}`}
                    />
                  }
                >
                  {COPY[need.action].button(need.label)}
                </Button>
              </li>
            );
          })}
        </ul>
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
}
