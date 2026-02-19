import { usePWAInstall } from "@/client/hooks/usePWAInstall";
import { useDialogControl } from "@/client/hooks/useDialogControl";
import { PWAQRCode } from "@/client/components/PWAQRCode";
import { BaseModal } from "@/client/components/Modal";
import {
  Check,
  Download,
  Ellipsis,
  Home,
  MoreVertical,
  Share,
  SquarePlus,
  X,
} from "lucide-react";

interface PWAInstallModalProps {
  open: boolean;
  onClose: () => void;
}

export function PWAInstallModal({ open, onClose }: PWAInstallModalProps) {
  const dialogRef = useDialogControl(open);
  const { platform, isStandalone, canPromptNatively, promptInstall } =
    usePWAInstall();

  const isDesktop = platform === "desktop";

  return (
    <BaseModal
      dialogRef={dialogRef}
      onClose={onClose}
      boxClassName={
        isDesktop ? "" : "w-full h-full max-w-none max-h-none rounded-none"
      }
      showBackdrop={false}
    >
      <button
        onClick={onClose}
        className="btn btn-sm btn-circle btn-ghost absolute right-2 top-2"
      >
        <X className="w-4 h-4" />
      </button>

      <div className={isDesktop ? "" : "flex justify-center pt-6"}>
        <div className={isDesktop ? "" : "w-full max-w-md"}>
          {isStandalone ? (
            <div className="text-center space-y-4 py-4">
              <div className="w-16 h-16 bg-success/20 rounded-full flex items-center justify-center mx-auto">
                <Check className="w-8 h-8 text-success" />
              </div>
              <h1 className="text-2xl font-bold">Already Installed</h1>
              <p className="text-base-content/70">
                You're already using Every App as an installed app.
              </p>
              <button onClick={onClose} className="btn btn-primary">
                <Home className="w-4 h-4" />
                Continue
              </button>
            </div>
          ) : (
            <div className="py-2">
              {/* Android with native prompt */}
              {platform === "android" && canPromptNatively && (
                <div className="text-center space-y-4">
                  <img
                    src="/android-chrome-192x192.png"
                    alt="Every App"
                    className="w-16 h-16 mx-auto rounded-xl"
                  />
                  <div>
                    <h2 className="text-xl font-semibold">Install Every App</h2>
                    <p className="text-base-content/60 text-sm">
                      Add to your home screen for an app-like experience
                    </p>
                  </div>
                  <button
                    onClick={promptInstall}
                    className="btn btn-primary btn-lg w-full"
                  >
                    <Download className="w-5 h-5" />
                    Install App
                  </button>
                </div>
              )}

              {/* Android without native prompt (fallback instructions) */}
              {platform === "android" && !canPromptNatively && (
                <AndroidInstructions onClose={onClose} />
              )}

              {/* iOS instructions */}
              {platform === "ios" && <IOSInstructions onClose={onClose} />}

              {/* Desktop */}
              {platform === "desktop" && <DesktopInstructions />}
            </div>
          )}
        </div>
      </div>
    </BaseModal>
  );
}

function IOSInstructions({ onClose }: { onClose: () => void }) {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">How to Install (iOS)</h2>
        <p className="text-sm text-base-content/60">
          Add to your home screen for an app-like experience
        </p>
      </div>
      <div className="space-y-4">
        <div className="flex items-start gap-4">
          <span className="w-8 h-8 rounded-full bg-primary text-primary-content flex items-center justify-center font-bold text-sm shrink-0">
            1
          </span>
          <div>
            <p className="font-medium flex items-center gap-2">
              Tap the <Ellipsis className="w-5 h-5" /> icon
            </p>
            <p className="text-sm text-base-content/60">
              Located in the browser toolbar
            </p>
          </div>
        </div>
        <div className="flex items-start gap-4">
          <span className="w-8 h-8 rounded-full bg-primary text-primary-content flex items-center justify-center font-bold text-sm shrink-0">
            2
          </span>
          <div>
            <p className="font-medium flex items-center gap-2">
              Tap <Share className="w-5 h-5" /> <span>Share</span>
            </p>
          </div>
        </div>
        <div className="flex items-start gap-4">
          <span className="w-8 h-8 rounded-full bg-primary text-primary-content flex items-center justify-center font-bold text-sm shrink-0">
            3
          </span>
          <div>
            <p className="font-medium flex items-center gap-2">
              Tap the <Ellipsis className="w-5 h-5" /> icon
            </p>
            <p className="text-sm text-base-content/60">In the bottom right</p>
          </div>
        </div>
        <div className="flex items-start gap-4">
          <span className="w-8 h-8 rounded-full bg-primary text-primary-content flex items-center justify-center font-bold text-sm shrink-0">
            4
          </span>
          <div>
            <p className="font-medium flex items-center gap-2">
              Tap <SquarePlus className="w-5 h-5" /> Add to Home Screen
            </p>
            <p className="text-sm text-base-content/60">
              At the bottom of the menu
            </p>
          </div>
        </div>
      </div>
      <button onClick={onClose} className="btn btn-primary w-full mt-6">
        Done
      </button>
    </div>
  );
}

function AndroidInstructions({ onClose }: { onClose: () => void }) {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">How to Install (Android)</h2>
        <p className="text-sm text-base-content/60">
          Add to your home screen for an app-like experience
        </p>
      </div>
      <div className="space-y-4">
        <div className="flex items-start gap-4">
          <span className="w-8 h-8 rounded-full bg-primary text-primary-content flex items-center justify-center font-bold text-sm shrink-0">
            1
          </span>
          <div>
            <p className="font-medium flex items-center gap-2">
              Tap the <MoreVertical className="w-5 h-5" /> menu icon
            </p>
            <p className="text-sm text-base-content/60">
              In the top right corner of your browser
            </p>
          </div>
        </div>
        <div className="flex items-start gap-4">
          <span className="w-8 h-8 rounded-full bg-primary text-primary-content flex items-center justify-center font-bold text-sm shrink-0">
            2
          </span>
          <div>
            <p className="font-medium flex items-center gap-2">
              Tap <SquarePlus className="w-5 h-5" /> Add to Home Screen
            </p>
            <p className="text-sm text-base-content/60">
              Or "Install App" if available
            </p>
          </div>
        </div>
        <div className="flex items-start gap-4">
          <span className="w-8 h-8 rounded-full bg-primary text-primary-content flex items-center justify-center font-bold text-sm shrink-0">
            3
          </span>
          <div>
            <p className="font-medium">
              Tap <span className="font-bold">Install</span>
            </p>
            <p className="text-sm text-base-content/60">
              In the confirmation dialog
            </p>
          </div>
        </div>
      </div>
      <button onClick={onClose} className="btn btn-primary w-full mt-6">
        Done
      </button>
    </div>
  );
}

function DesktopInstructions() {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Install on Mobile</h2>
        <p className="text-sm text-base-content/60 mt-1">
          Scan the QR code with your phone to install Every App as a mobile app.
        </p>
      </div>
      <PWAQRCode />
    </div>
  );
}
