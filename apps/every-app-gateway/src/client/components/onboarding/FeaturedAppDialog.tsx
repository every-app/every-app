import { ExternalLink } from "lucide-react";
import { cn } from "cn";
import { CodeBlock } from "@/client/components/CodeBlock";
import {
  FeaturedAppIcon,
  PhoneNotice,
} from "@/client/components/onboarding/AppGallery";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/client/components/ui/dialog";
import {
  featuredInstallCommand,
  type FeaturedApp,
} from "@/client/lib/featuredApps";
import { FIRST_SCREEN } from "@/client/lib/firstScreen";

interface FeaturedAppContentProps {
  app: FeaturedApp;
  /** Whoever reads it can run the command: an owner or admin. */
  canRun: boolean;
}

/**
 * One of the four apps before it is installed: the one command that
 * installs it, and what to have ready. Shared by the home's dialog and
 * the Add app chooser.
 */
export function FeaturedAppContent({ app, canRun }: FeaturedAppContentProps) {
  const copy = FIRST_SCREEN.appDialog;
  return (
    <>
      <DialogHeader className="flex-row items-center gap-3">
        <FeaturedAppIcon app={app} className="size-10 rounded-lg md:mb-0" />
        <div className="flex min-w-0 flex-col gap-1">
          <DialogTitle>{app.name}</DialogTitle>
          <DialogDescription>{copy.description(app.name)}</DialogDescription>
        </div>
      </DialogHeader>
      {canRun ? <PhoneNotice /> : null}
      {canRun ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">{copy.commandHeading}</p>
          <CodeBlock
            code={featuredInstallCommand(app)}
            successMessage="Command copied"
          />
          <p className="text-xs text-muted-foreground">{copy.commandNote}</p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{copy.memberLine}</p>
      )}
      <div className="flex flex-col gap-1.5">
        <p className="text-sm font-medium">{copy.needsHeading}</p>
        <ul className="list-disc pl-5 text-sm text-muted-foreground">
          {app.needs.map((need) => (
            <li key={need}>{need}</li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">{copy.needsNote}</p>
      </div>
    </>
  );
}

/** The app's repository, for whoever wants to read it first. */
export function FeaturedAppRepoLink({
  app,
  className = "sm:mr-auto sm:self-center",
}: {
  app: Pick<FeaturedApp, "repo">;
  /** Where it sits in the footer: alone on the left by default. */
  className?: string;
}) {
  return (
    <a
      href={app.repo}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "inline-flex min-h-10 items-center gap-1 text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground sm:min-h-0",
        className,
      )}
    >
      {FIRST_SCREEN.appDialog.repoLinkLabel}
      <ExternalLink className="size-3" aria-hidden />
    </a>
  );
}

/** The home's dialog for one of the four apps. Render it only while it is open. */
export function FeaturedAppDialog({
  app,
  canRun,
  onClose,
}: FeaturedAppContentProps & { onClose: () => void }) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent showCloseButton={false} className="sm:max-w-xl">
        <FeaturedAppContent app={app} canRun={canRun} />
        <DialogFooter showCloseButton>
          <FeaturedAppRepoLink app={app} />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
