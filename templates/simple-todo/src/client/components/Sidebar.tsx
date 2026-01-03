import { Link } from "@tanstack/react-router";
import { ClipboardList, History } from "lucide-react";

interface SidebarProps {
  currentPath: string;
}

export function Sidebar({ currentPath }: SidebarProps) {
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
  ];

  return (
    <div className="sidebar w-64 border-r border-base-300 h-full bg-base-100 flex flex-col">
      {/* Header */}
      <div className="px-4 py-4 border-b border-base-300">
        <a
          href={import.meta.env.VITE_GATEWAY_URL}
          target="_top"
          className="font-semibold text-base-content hover:text-primary transition-colors"
        >
          Every App
        </a>
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-4 pl-3 overflow-y-auto">
        {navItems.map((item) => {
          const Icon = item.icon;

          return (
            <Link
              key={item.to}
              to={item.to}
              className={`relative flex items-center gap-3 pl-4 pr-4 py-2 text-sm transition-colors ${
                item.isActive
                  ? "text-base-content font-medium"
                  : "text-base-content/60 hover:text-base-content hover:bg-base-200"
              }`}
            >
              {item.isActive && (
                <div className="absolute left-0 top-1 bottom-1 w-[3px] bg-primary rounded-r-full" />
              )}
              <Icon className="h-5 w-5" />
              {item.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
