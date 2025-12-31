import { useMemo } from "react";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { detectPlatform, isMobilePlatform } from "@/utils/platform";

interface PWAInstallStepProps {
  isExpanded: boolean;
  onToggle: () => void;
  onComplete: () => void;
  onSkip: () => void;
  onSkipPermanently: () => void;
  showSkipPermanently: boolean;
  isComplete: boolean;
}

export function PWAInstallStep({
  isExpanded,
  onToggle,
  onComplete,
  onSkip,
  onSkipPermanently,
  showSkipPermanently,
  isComplete,
}: PWAInstallStepProps) {
  // Platform doesn't change during a session, compute once
  const platform = useMemo(() => detectPlatform(), []);
  const pwaUrl = useMemo(
    () =>
      typeof window === "undefined" ? "/pwa" : `${window.location.origin}/pwa`,
    [],
  );
  const isMobile = isMobilePlatform(platform);

  return (
    <div className="border border-base-content/20 rounded-lg overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between p-4 hover:bg-base-200 transition-colors text-left"
      >
        <div className="flex items-center gap-3">
          <div>
            <h3 className="font-semibold">
              {isComplete ? "Mobile app installed" : "Add to your phone (PWA)"}
            </h3>
            <p className="text-sm text-base-content/70">
              {isComplete
                ? "You're all set!"
                : "Install Every App as a mobile app for quick access"}
            </p>
          </div>
        </div>
        {!isComplete &&
          (isExpanded ? (
            <ChevronDown className="w-5 h-5 text-base-content/50" />
          ) : (
            <ChevronRight className="w-5 h-5 text-base-content/50" />
          ))}
      </button>

      {isExpanded && !isComplete && (
        <div className="px-4 pb-4 pt-2 space-y-4">
          <div className="bg-base-200/50 rounded-lg p-4">
            {isMobile ? (
              // Mobile: Link directly to /pwa page
              <div className="space-y-3">
                <span className="text-sm font-medium">
                  {platform === "ios"
                    ? "Install on iPhone/iPad"
                    : "Install on Android"}
                </span>
                <p className="text-sm text-base-content/70">
                  Follow the step-by-step instructions to add Every App to your
                  home screen.
                </p>
                <a href="/pwa" className="btn btn-primary btn-sm">
                  View Installation Instructions
                </a>
              </div>
            ) : (
              // Desktop: Show QR code
              <div className="space-y-4">
                <span className="text-sm font-medium">
                  Scan to install on your phone
                </span>
                <p className="text-sm text-base-content/70">
                  This page has instructions for how to save Every App as a
                  Mobile App (PWA).
                </p>
                <div className="bg-white p-3 rounded-lg w-fit">
                  <QRCodeSVG value={pwaUrl} size={140} level="M" />
                </div>
                <p className="text-xs text-base-content/50">
                  Or go to,
                  <code className="bg-base-300 px-1.5 py-0.5 rounded text-base-content/70">
                    {pwaUrl}
                  </code>
                </p>
              </div>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <button onClick={onComplete} className="btn btn-primary btn-sm">
              I've installed it
            </button>
            {showSkipPermanently ? (
              <button
                onClick={onSkipPermanently}
                className="btn btn-ghost btn-sm"
              >
                Skip permanently
              </button>
            ) : (
              <button onClick={onSkip} className="btn btn-ghost btn-sm">
                Skip for now
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
