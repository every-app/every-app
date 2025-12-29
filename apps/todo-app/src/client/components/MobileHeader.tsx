interface MobileHeaderProps {
  currentPath: string;
}

export function MobileHeader({ currentPath }: MobileHeaderProps) {
  const getPageTitle = (path: string) => {
    switch (path) {
      case "/":
        return "Todos";
      case "/history":
        return "History";
      default:
        return "Todos";
    }
  };

  return (
    <div className="mobile-header fixed top-0 left-0 right-0 bg-base-100 border-b border-base-300 px-4 py-3 z-50">
      <h1 className="text-xl font-semibold text-base-content">
        {getPageTitle(currentPath)}
      </h1>
    </div>
  );
}
