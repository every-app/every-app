import useDetectKeyboardOpen from "@/client/hooks/useDetectKeyboardOpen";
import { Link } from "@tanstack/react-router";
import { ClipboardList, Dumbbell, History, LayoutGrid } from "lucide-react";

interface TabBarProps {
  currentPath: string;
}

export function TabBar({ currentPath }: TabBarProps) {
  const isKeyboardOpen = useDetectKeyboardOpen();

  if (isKeyboardOpen) return null;

  const navItems = [
    {
      to: "/",
      label: "Home",
      icon: ClipboardList,
      isActive: currentPath === "/" || currentPath === "/workout",
    },
    {
      to: "/programs",
      label: "Programs",
      icon: Dumbbell,
      isActive: currentPath.startsWith("/programs"),
    },
    {
      to: "/history",
      label: "History",
      icon: History,
      isActive: currentPath === "/history",
    },
    {
      to: "parent",
      label: "Apps",
      icon: LayoutGrid,
      isActive: false,
    },
  ];

  return (
    <div className="fixed bottom-0 left-0 right-0 bg-base-100 border-t border-base-300 pb-safe">
      <nav className="flex justify-around items-center max-w-md mx-auto py-2 px-4">
        {navItems.map((item) => {
          const Icon = item.icon;

          if (item.to === "parent") {
            return (
              <a
                key={item.label}
                href={import.meta.env.VITE_GATEWAY_URL}
                target="_top"
                className={`flex flex-col items-center gap-1 px-3 py-2 text-xs font-medium transition-colors text-base-content/60 hover:text-base-content focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:outline-none`}
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
              className={`flex flex-col items-center gap-1 px-3 py-2 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:outline-none ${
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
