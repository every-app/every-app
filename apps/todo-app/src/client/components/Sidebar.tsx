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
    <div className="w-64 bg-gray-50 border-r border-gray-200 h-full">
      <div className="px-4 py-2 border-b border-gray-300 mb-2">
        <a
          href={import.meta.env.VITE_GATEWAY_URL}
          target="_top"
          className={`text-lg font-semibold text-gray-900 mb-4`}
        >
          Every App
        </a>
      </div>
      <div className="px-4 py-2">
        <nav className="space-y-2">
          {navItems.map((item) => {
            const Icon = item.icon;

            if (item.to === "parent") {
              return (
                <a
                  key={item.label}
                  href="/"
                  target="_parent"
                  className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors text-gray-600 hover:bg-gray-100 hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2 focus-visible:outline-none`}
                >
                  <Icon className="h-5 w-5" />
                  {item.label}
                </a>
              );
            }

            return (
              <Link
                key={item.to}
                to={item.to}
                className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2 focus-visible:outline-none ${
                  item.isActive
                    ? "bg-blue-100 text-blue-700"
                    : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
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
