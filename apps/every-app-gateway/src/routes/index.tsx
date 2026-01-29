import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { useSession } from "@/client/hooks/useSession";
import { userAppsCollection } from "@/client/tanstack-db";
import { useState, useEffect, useRef } from "react";
import { z } from "zod";
import { Code, Settings } from "lucide-react";
import { PWAInstallModal } from "@/client/components/PWAInstallModal";
import { SafariDevModeWarningModal } from "@/client/components/SafariDevModeWarningModal";
import { OnboardingBanner } from "@/client/components/onboarding/OnboardingBanner";
import { AppListItem, DevAppListItem } from "@/client/components/AppListItem";
import { Header } from "@/client/components/Header";
import { isSafari } from "@/client/utils/browser";

const searchSchema = z.object({
  // Handle both boolean (from programmatic navigation) and string (from URL)
  // Falls back to undefined for any invalid values to prevent hard crashes
  pwa: z
    .union([z.boolean(), z.literal("true"), z.literal("false")])
    .transform((val) => val === true || val === "true")
    .optional()
    .catch(undefined),
});

export const Route = createFileRoute("/")({
  validateSearch: searchSchema,
  component: App,
});

const SHOW_DEV_URLS_KEY = "gateway-show-dev-urls";

function isMobileScreen() {
  if (typeof window === "undefined") return false;
  return window.innerWidth < 640;
}

function useShowDevUrls() {
  const [showDevUrls, setShowDevUrls] = useState(() => {
    if (typeof window === "undefined") return true;
    const stored = localStorage.getItem(SHOW_DEV_URLS_KEY);
    if (stored === null) {
      // Default to false on mobile if not previously set
      return !isMobileScreen();
    }
    return stored === "true";
  });

  useEffect(() => {
    localStorage.setItem(SHOW_DEV_URLS_KEY, String(showDevUrls));
  }, [showDevUrls]);

  return [showDevUrls, setShowDevUrls] as const;
}

function App() {
  const session = useSession();
  const { pwa: pwaParam } = Route.useSearch();
  const [showPWAInstallModal, setShowPWAInstallModal] = useState(false);
  const [showDevUrls, setShowDevUrls] = useShowDevUrls();
  const [showSafariWarning, setShowSafariWarning] = useState(false);
  const navigate = useNavigate();
  const hasStrippedPwaParam = useRef(false);
  const userIsOwner = session.data?.user.role === "owner";

  // Open PWA modal when ?pwa=true is present, then strip the param
  useEffect(() => {
    if (pwaParam && !hasStrippedPwaParam.current) {
      setShowPWAInstallModal(true);
      hasStrippedPwaParam.current = true;
      // Strip the ?pwa param from the URL without closing the modal
      navigate({ to: "/", search: {}, replace: true });
    }
  }, [pwaParam, navigate]);

  // Use TanStack DB live query - always subscribe to the collection
  // This ensures mutations work immediately without needing to refresh
  const {
    data: userApps,
    isLoading,
    isError,
  } = useLiveQuery((q) => q.from({ userApp: userAppsCollection }));

  const hasAnyDevUrls = userApps?.some((app) => app.devUrl) ?? false;

  return (
    <div className="bg-base-100 h-full flex flex-col">
      <Header email={session.data?.user.email} role={session.data?.user.role} />
      <div className="flex-1 min-h-0 animate-fade-in">
        <div className="max-w-4xl mx-auto px-4 py-6 h-full flex flex-col">
          <div className="space-y-6">
            <div className="flex justify-between items-start w-full">
              <div>
                <div className="flex items-center gap-3">
                  <h2 className="text-2xl font-bold">Gateway</h2>
                  {hasAnyDevUrls && (
                    <label className="hidden sm:flex items-center gap-1.5 cursor-pointer">
                      <Code className="w-4 h-4 text-base-content/50" />
                      <input
                        type="checkbox"
                        className="toggle toggle-xs toggle-primary"
                        checked={showDevUrls}
                        onChange={(e) => setShowDevUrls(e.target.checked)}
                      />
                    </label>
                  )}
                </div>
                <p className="text-base-content/70 mt-2">Access your apps</p>
              </div>
              <div className="flex items-center gap-2">
                {hasAnyDevUrls && (
                  <label className="flex sm:hidden items-center gap-1.5 cursor-pointer">
                    <Code className="w-4 h-4 text-base-content/50" />
                    <input
                      type="checkbox"
                      className="toggle toggle-xs toggle-primary"
                      checked={showDevUrls}
                      onChange={(e) => setShowDevUrls(e.target.checked)}
                    />
                  </label>
                )}
                {userIsOwner && (
                  <Link
                    to="/admin/apps"
                    className="btn btn-primary hidden sm:flex"
                  >
                    <Settings className="w-4 h-4" />
                    Manage Apps
                  </Link>
                )}
              </div>
            </div>

            <OnboardingBanner />
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto pt-4 scrollbar-stable scrollbar-hidden-mobile">
            {isError && (
              <div className="text-center py-8">
                <p className="text-error">
                  Failed to load apps. Please try again.
                </p>
              </div>
            )}

            {!isLoading && userApps && userApps.length > 0 && (
              <div className="w-full space-y-3">
                {userApps.map((app) => (
                  <ul key={app.id} className="space-y-2">
                    <AppListItem
                      app={app}
                      onNavigate={() => navigate({ to: `/apps/${app.appId}` })}
                    />
                    {showDevUrls && app.devUrl && (
                      <DevAppListItem
                        app={app}
                        onNavigate={() => {
                          if (isSafari()) {
                            setShowSafariWarning(true);
                          } else {
                            navigate({
                              to: `/apps/${app.appId}/dev`,
                            });
                          }
                        }}
                      />
                    )}
                  </ul>
                ))}
              </div>
            )}

            {!isLoading && userApps && userApps.length === 0 && (
              <div className="text-center py-8">
                <p className="text-base-content/70">
                  {userIsOwner
                    ? "No apps yet. Add your first app to get started!"
                    : "No apps available. Contact your administrator to get access."}
                </p>
                {userIsOwner && (
                  <Link to="/admin/apps" className="btn btn-primary mt-4">
                    <Settings className="w-4 h-4" />
                    Manage Apps
                  </Link>
                )}
              </div>
            )}
          </div>

          <PWAInstallModal
            open={showPWAInstallModal}
            onClose={() => setShowPWAInstallModal(false)}
          />
          <SafariDevModeWarningModal
            open={showSafariWarning}
            onOpenChange={setShowSafariWarning}
          />
        </div>
      </div>
    </div>
  );
}
