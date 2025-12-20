import useDetectKeyboardOpen from "@/client/hooks/useDetectKeyboardOpen";
import { Link, useLocation } from "@tanstack/react-router";
import { ClipboardList, History, Home } from "lucide-react";

export function TabBar() {
  const isKeyboardOpen = useDetectKeyboardOpen();
  const currentPath = useLocation({ select: (loc) => loc.pathname });

  if (isKeyboardOpen) return null;
  const navItems = [
    {
      to: "/",
      label: "Todos",
      icon: ClipboardList,
      isActive: currentPath === "/",
    },
    {
      to: "/history",
      label: "History",
      icon: History,
      isActive: currentPath === "/history",
    },
    {
      to: "parent",
      label: "Every App",
      icon: Home,
      isActive: false,
    },
  ];

  return (
    <div className="bg-base-100 border-t border-base-300 pb-safe">
      <nav className="flex justify-around items-center max-w-md mx-auto py-2 px-4">
        {navItems.map((item) => {
          const Icon = item.icon;

          if (item.to === "parent") {
            return (
              <a
                key={item.label}
                href={import.meta.env.VITE_GATEWAY_URL}
                target="_top"
                className="flex flex-col items-center gap-1 px-3 py-2 rounded-md text-xs font-medium transition-colors text-base-content/60 hover:text-base-content"
                aria-label={`Navigate to ${item.label}`}
              >
                <Icon className="h-5 w-5" aria-hidden="true" />
                <span>{item.label}</span>
              </a>
            );
          }

          return (
            <Link
              key={item.to}
              to={item.to}
              className={`flex flex-col items-center gap-1 px-3 py-2 rounded-md text-xs font-medium transition-colors ${
                item.isActive
                  ? "text-primary"
                  : "text-base-content/60 hover:text-base-content"
              }`}
              aria-label={`Navigate to ${item.label}`}
              aria-current={item.isActive ? "page" : undefined}
            >
              <Icon className="h-5 w-5" aria-hidden="true" />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
