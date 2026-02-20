import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <div className="flex items-center gap-2">
          <img
            src="/transparent-logo-256.png"
            alt="Every App"
            className="w-6 h-6"
            width={24}
            height={24}
          />
          <span>Every App</span>
        </div>
      ),
    },
    links: [
      { text: "Docs", url: "/docs" },
      {
        text: "Discord",
        url: "https://discord.gg/c9uGs3cFXr",
        external: true,
      },
      {
        text: "GitHub",
        url: "https://github.com/every-app/every-app",
        external: true,
      },
    ],
  };
}
