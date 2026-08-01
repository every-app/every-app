import { Link } from "@tanstack/react-router";
import { Home, Dumbbell, History } from "lucide-react";
import { gatewayHomeUrl } from "@/client/lib/gatewayHome";

interface SidebarProps {
  currentPath: string;
}

export function Sidebar({ currentPath }: SidebarProps) {
  const navItems = [
    {
      to: "/",
      label: "Home",
      icon: Home,
      isActive: currentPath === "/",
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
  ];

  return (
    <div className="sidebar w-64 bg-base-100 border-r border-base-300 h-full">
      <div className="px-4 py-2 border-b border-base-300 mb-2">
        <a
          href={gatewayHomeUrl()}
          target="_top"
          className="text-lg font-semibold text-base-content"
        >
          Every App
        </a>
      </div>
      <div className="px-4 py-2">
        <nav className="space-y-2">
          {navItems.map((item) => {
            const Icon = item.icon;

            return (
              <Link
                key={item.to}
                to={item.to}
                className={`flex items-center gap-3 px-3 py-2 rounded text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:outline-none ${
                  item.isActive
                    ? "bg-base-300 text-base-content"
                    : "text-base-content/70 hover:bg-base-200 hover:text-base-content"
                }`}
              >
                <Icon className="h-5 w-5" />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
