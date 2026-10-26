import type { ReactNode } from "react";
import { usePWAInstall } from "@/client/hooks/usePWAInstall";
import { PWAQRCode } from "@/client/components/PWAQRCode";
import { Button } from "@/client/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/client/components/ui/dialog";
import {
  Check,
  Download,
  Ellipsis,
  Home,
  MoreVertical,
  Share,
  SquarePlus,
} from "lucide-react";

interface PWAInstallModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * How to install the gateway as an app on this device. On a phone it fills
 * the screen (people land on it from the QR code); on a computer it is a
 * dialog with that QR code.
 *
 * Keep it mounted: `usePWAInstall` has to catch `beforeinstallprompt` before
 * the dialog opens.
 */
export function PWAInstallModal({ open, onClose }: PWAInstallModalProps) {
  const { platform, isStandalone, canPromptNatively, promptInstall } =
    usePWAInstall();

  const isDesktop = platform === "desktop";

  let body: ReactNode = null;
  if (isStandalone) {
    body = <AlreadyInstalled onClose={onClose} />;
  } else if (platform === "android" && canPromptNatively) {
    // Android with native prompt
    body = <AndroidPrompt onInstall={() => void promptInstall()} />;
  } else if (platform === "android") {
    // Android without native prompt (fallback instructions)
    body = <AndroidInstructions onClose={onClose} />;
  } else if (platform === "ios") {
    body = <IOSInstructions onClose={onClose} />;
  } else if (platform === "desktop") {
    body = <DesktopInstructions />;
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent
        className={
          isDesktop
            ? "sm:max-w-md"
            : "h-[100dvh] max-h-none w-full max-w-none content-start rounded-none border-0 pt-12 sm:max-w-none"
        }
      >
        {isDesktop ? (
          body
        ) : (
          <div className="mx-auto grid w-full max-w-md gap-4">{body}</div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function AlreadyInstalled({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex flex-col items-center gap-4 py-4 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-success/10 text-success">
        <Check className="size-6" aria-hidden />
      </span>
      <DialogHeader className="items-center">
        <DialogTitle>Already installed</DialogTitle>
        <DialogDescription>
          You're already using EveryApp as an installed app.
        </DialogDescription>
      </DialogHeader>
      <Button onClick={onClose}>
        <Home data-icon="inline-start" />
        Continue
      </Button>
    </div>
  );
}

function AndroidPrompt({ onInstall }: { onInstall: () => void }) {
  return (
    <div className="flex flex-col items-center gap-4 text-center">
      <img
        src="/android-chrome-192x192.png"
        alt="EveryApp"
        className="size-16 rounded-xl"
      />
      <DialogHeader className="items-center">
        <DialogTitle>Install EveryApp</DialogTitle>
        <DialogDescription>
          Add to your home screen for an app-like experience
        </DialogDescription>
      </DialogHeader>
      <Button size="lg" className="w-full" onClick={onInstall}>
        <Download data-icon="inline-start" />
        Install app
      </Button>
    </div>
  );
}

function IOSInstructions({ onClose }: { onClose: () => void }) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>How to install (iOS)</DialogTitle>
        <DialogDescription>
          Add to your home screen for an app-like experience
        </DialogDescription>
      </DialogHeader>
      <ol className="space-y-4">
        <InstallStep
          number={1}
          hint="Located in the browser toolbar"
          title={
            <>
              Tap the <Ellipsis className="size-4" /> icon
            </>
          }
        />
        <InstallStep
          number={2}
          title={
            <>
              Tap <Share className="size-4" /> Share
            </>
          }
        />
        <InstallStep
          number={3}
          hint="In the bottom right"
          title={
            <>
              Tap the <Ellipsis className="size-4" /> icon
            </>
          }
        />
        <InstallStep
          number={4}
          hint="At the bottom of the menu"
          title={
            <>
              Tap <SquarePlus className="size-4" /> Add to Home Screen
            </>
          }
        />
      </ol>
      <Button className="mt-2 w-full" onClick={onClose}>
        Done
      </Button>
    </>
  );
}

function AndroidInstructions({ onClose }: { onClose: () => void }) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>How to install (Android)</DialogTitle>
        <DialogDescription>
          Add to your home screen for an app-like experience
        </DialogDescription>
      </DialogHeader>
      <ol className="space-y-4">
        <InstallStep
          number={1}
          hint="In the top right corner of your browser"
          title={
            <>
              Tap the <MoreVertical className="size-4" /> menu icon
            </>
          }
        />
        <InstallStep
          number={2}
          hint={`Or "Install App" if available`}
          title={
            <>
              Tap <SquarePlus className="size-4" /> Add to Home Screen
            </>
          }
        />
        <InstallStep
          number={3}
          hint="In the confirmation dialog"
          title={
            <>
              Tap <span className="font-semibold">Install</span>
            </>
          }
        />
      </ol>
      <Button className="mt-2 w-full" onClick={onClose}>
        Done
      </Button>
    </>
  );
}

function DesktopInstructions() {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Install on mobile</DialogTitle>
        <DialogDescription>
          Scan with your phone to install EveryApp.
        </DialogDescription>
      </DialogHeader>
      <div className="flex justify-center">
        <PWAQRCode />
      </div>
    </>
  );
}

/** One numbered instruction, with an optional hint under it. */
function InstallStep({
  number,
  title,
  hint,
}: {
  number: number;
  title: ReactNode;
  hint?: string;
}) {
  return (
    <li className="flex items-start gap-3">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary tabular-nums">
        {number}
      </span>
      <div className="min-w-0 space-y-0.5 pt-0.5">
        <p className="flex flex-wrap items-center gap-1.5 font-medium">
          {title}
        </p>
        {hint ? <p className="text-muted-foreground">{hint}</p> : null}
      </div>
    </li>
  );
}
