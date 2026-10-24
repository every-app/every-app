import { ExternalLink } from "lucide-react";
import { cn } from "cn";
import { CopyButton } from "@/client/components/CopyButton";
import { PhoneNotice } from "@/client/components/onboarding/AppGallery";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/client/components/ui/dialog";
import { BUILD_DOCS, BUILD_PROMPT } from "@/client/lib/buildPrompt";
import { FIRST_SCREEN } from "@/client/lib/firstScreen";

/**
 * An app of their own: the prompt for the person's coding agent, which
 * interviews them and then builds and deploys the app. Shared by the
 * home's dialog and the Add app chooser.
 */
export function BuildYourOwnContent() {
  const copy = FIRST_SCREEN.buildDialog;
  return (
    <>
      <DialogHeader>
        <DialogTitle>{copy.title}</DialogTitle>
        <DialogDescription>{copy.description}</DialogDescription>
      </DialogHeader>
      <PhoneNotice />
      <div
        role="region"
        aria-label="Prompt"
        tabIndex={0}
        className="max-h-[60vh] overflow-y-auto rounded-lg border border-border bg-muted px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {BUILD_PROMPT}
      </div>
    </>
  );
}

/** The dialog's two actions: read how it works, copy the prompt. */
export function BuildYourOwnActions({
  linkClassName = "sm:mr-auto sm:self-center",
}: {
  /** Where the docs link sits in the footer: alone on the left by default. */
  linkClassName?: string;
}) {
  const copy = FIRST_SCREEN.buildDialog;
  return (
    <>
      <a
        href={BUILD_DOCS.createAnApp}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(
          "inline-flex min-h-10 items-center gap-1 text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground sm:min-h-0",
          linkClassName,
        )}
      >
        {copy.docsLinkLabel}
        <ExternalLink className="size-3" aria-hidden />
      </a>
      <CopyButton
        value={BUILD_PROMPT}
        successMessage="Prompt copied"
        label={copy.copyButton}
        variant="default"
        size="default"
      />
    </>
  );
}

/** The home's Build your own dialog. Render it only while it is open. */
export function BuildYourOwnDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent showCloseButton={false} className="sm:max-w-xl">
        <BuildYourOwnContent />
        <DialogFooter showCloseButton>
          <BuildYourOwnActions />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
