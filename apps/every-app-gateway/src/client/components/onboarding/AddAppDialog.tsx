import { useRef, useState } from "react";
import { ArrowLeft, ChevronRight, Sparkles } from "lucide-react";
import {
  FeaturedAppIcon,
  GalleryIconTile,
} from "@/client/components/onboarding/AppGallery";
import {
  BuildYourOwnActions,
  BuildYourOwnContent,
} from "@/client/components/onboarding/BuildYourOwnDialog";
import {
  FeaturedAppContent,
  FeaturedAppRepoLink,
} from "@/client/components/onboarding/FeaturedAppDialog";
import { Button } from "@/client/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/client/components/ui/dialog";
import { FEATURED_APPS, type FeaturedApp } from "@/client/lib/featuredApps";
import { FIRST_SCREEN } from "@/client/lib/firstScreen";

type View =
  | { kind: "list" }
  | { kind: "app"; app: FeaturedApp }
  | { kind: "build" };

/**
 * The gallery folded into one dialog, for Manage workspace → Apps once the
 * home shows real apps: the four apps and Build your own as rows, each
 * opening the same content the home's cards open. Render it only while it
 * is open.
 */
export function AddAppDialog({
  canRun,
  onClose,
}: {
  /** Whoever reads it can run the install command: an owner or admin. */
  canRun: boolean;
  onClose: () => void;
}) {
  const [view, setView] = useState<View>({ kind: "list" });
  // The button that opened a view unmounts with it, so the view that
  // replaces it takes focus: Back on a detail, the first row on the list.
  const returned = useRef(false);
  const back = (
    <Button
      variant="ghost"
      autoFocus
      onClick={() => {
        returned.current = true;
        setView({ kind: "list" });
      }}
    >
      <ArrowLeft data-icon="inline-start" />
      Back
    </Button>
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent showCloseButton={false} className="sm:max-w-xl">
        {view.kind === "list" ? (
          <>
            <DialogHeader>
              <DialogTitle>{FIRST_SCREEN.addApp.dialogTitle}</DialogTitle>
              <DialogDescription>
                {FIRST_SCREEN.addApp.dialogDescription}
              </DialogDescription>
            </DialogHeader>
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
              {FEATURED_APPS.map((app, index) => (
                <ChooserRow
                  key={app.id}
                  autoFocus={index === 0 && returned.current}
                  title={app.name}
                  line={app.line}
                  icon={
                    <FeaturedAppIcon
                      app={app}
                      className="size-8 rounded-lg md:mb-0 md:size-8"
                    />
                  }
                  onClick={() => setView({ kind: "app", app })}
                />
              ))}
              <ChooserRow
                title={FIRST_SCREEN.buildCard.title}
                line={FIRST_SCREEN.buildCard.line}
                icon={
                  <GalleryIconTile className="size-8 rounded-lg bg-primary/10 text-primary md:mb-0 md:size-8">
                    <Sparkles className="size-4" aria-hidden />
                  </GalleryIconTile>
                }
                onClick={() => setView({ kind: "build" })}
              />
            </ul>
            <DialogFooter showCloseButton />
          </>
        ) : view.kind === "app" ? (
          <>
            <FeaturedAppContent app={view.app} canRun={canRun} />
            <DialogFooter showCloseButton>
              <div className="flex items-center gap-4 sm:mr-auto">
                {back}
                <FeaturedAppRepoLink app={view.app} className="" />
              </div>
            </DialogFooter>
          </>
        ) : (
          <>
            <BuildYourOwnContent />
            <DialogFooter showCloseButton>
              <div className="flex items-center gap-4 sm:mr-auto">
                {back}
                <BuildYourOwnActions linkClassName="" />
              </div>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ChooserRow({
  title,
  line,
  icon,
  autoFocus = false,
  onClick,
}: {
  title: string;
  line: string;
  icon: React.ReactNode;
  autoFocus?: boolean;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        autoFocus={autoFocus}
        onClick={onClick}
        className="flex w-full cursor-pointer items-center gap-3 px-3 py-2.5 text-left outline-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
      >
        {icon}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-medium">{title}</span>
          <span className="text-xs text-muted-foreground">{line}</span>
        </span>
        <ChevronRight
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden
        />
      </button>
    </li>
  );
}
