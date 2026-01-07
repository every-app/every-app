import { createFileRoute, Link } from "@tanstack/react-router";
import { usePWAInstall } from "@/client/hooks/usePWAInstall";
import { Header } from "@/client/components/Header";
import { useSession } from "@/client/hooks/useSession";
import {
  ArrowLeft,
  Check,
  Download,
  Ellipsis,
  Home,
  MoreVertical,
  Share,
  SquarePlus,
} from "lucide-react";

export const Route = createFileRoute("/pwa")({
  component: PWAInstallPage,
});

function PWAInstallPage() {
  const session = useSession();
  const { platform, isStandalone, canPromptNatively, promptInstall } =
    usePWAInstall();

  // Already installed as PWA
  if (isStandalone) {
    return (
      <div className="bg-base-100 h-screen flex flex-col">
        <Header
          email={session.data?.user.email}
          role={session.data?.user.role}
        />
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="text-center space-y-4">
            <div className="w-16 h-16 bg-success/20 rounded-full flex items-center justify-center mx-auto">
              <Check className="w-8 h-8 text-success" />
            </div>
            <h1 className="text-2xl font-bold">Already Installed</h1>
            <p className="text-base-content/70">
              You're already using Every App as an installed app.
            </p>
            <Link to="/" className="btn btn-primary">
              <Home className="w-4 h-4" />
              Go to Home
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-base-100 h-screen flex flex-col">
      <Header email={session.data?.user.email} role={session.data?.user.role} />
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-4 py-8">
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
            <AndroidInstructions />
          )}

          {/* iOS instructions */}
          {platform === "ios" && <IOSInstructions />}

          {/* Desktop */}
          {platform === "desktop" && <DesktopInstructions />}

          <div className="mt-8">
            <Link
              to="/"
              className="text-sm text-base-content/60 hover:text-base-content inline-flex items-center gap-1"
            >
              <ArrowLeft className="w-4 h-4" />
              Back to Home
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

function IOSInstructions() {
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
              Tap <SquarePlus className="w-5 h-5" />{" "}
              <span>Add to Home Screen (bottom of the page)</span>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function AndroidInstructions() {
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
              Tap <SquarePlus className="w-5 h-5" />{" "}
              <span>Add to home screen</span>
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
          </div>
        </div>
      </div>
    </div>
  );
}

function DesktopInstructions() {
  return (
    <div className="space-y-4">
      <div className="alert alert-info">
        <p>
          PWA installation works best on mobile devices. Visit this page on your
          phone to install Every App.
        </p>
      </div>
      <h2 className="text-lg font-semibold">Desktop Installation</h2>
      <p className="text-base-content/70">
        Most desktop browsers support PWA installation. Look for an install icon
        in your browser's address bar, or check the browser menu for an "Install
        App" option.
      </p>
    </div>
  );
}
