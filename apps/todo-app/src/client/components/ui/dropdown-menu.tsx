import {
  createContext,
  useContext,
  useState,
  useRef,
  useEffect,
  forwardRef,
} from "react";
import type {
  ReactNode,
  ButtonHTMLAttributes,
  LiHTMLAttributes,
  RefObject,
  MutableRefObject,
} from "react";

interface DropdownMenuContextType {
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}

const DropdownMenuContext = createContext<DropdownMenuContextType | null>(null);

function useDropdownMenu() {
  const context = useContext(DropdownMenuContext);
  if (!context) {
    throw new Error("Dropdown components must be used within a DropdownMenu");
  }
  return context;
}

function DropdownMenu({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <DropdownMenuContext.Provider value={{ isOpen, setIsOpen, triggerRef }}>
      <div className="dropdown dropdown-end">{children}</div>
    </DropdownMenuContext.Provider>
  );
}

const DropdownMenuTrigger = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement>
>(({ children, onClick, ...props }, ref) => {
  const { isOpen, setIsOpen, triggerRef } = useDropdownMenu();

  // Merge refs
  const mergedRef = (node: HTMLButtonElement) => {
    (triggerRef as MutableRefObject<HTMLButtonElement | null>).current = node;
    if (typeof ref === "function") {
      ref(node);
    } else if (ref) {
      ref.current = node;
    }
  };

  return (
    <button
      ref={mergedRef}
      type="button"
      onClick={(e) => {
        setIsOpen(!isOpen);
        onClick?.(e);
      }}
      {...props}
    >
      {children}
    </button>
  );
});
DropdownMenuTrigger.displayName = "DropdownMenuTrigger";

function DropdownMenuContent({ children }: { children: ReactNode }) {
  const { isOpen, setIsOpen, triggerRef } = useDropdownMenu();
  const contentRef = useRef<HTMLUListElement>(null);

  // Close on click outside or Escape key
  useEffect(() => {
    if (!isOpen) return;

    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node;
      if (
        contentRef.current &&
        !contentRef.current.contains(target) &&
        triggerRef.current &&
        !triggerRef.current.contains(target)
      ) {
        setIsOpen(false);
      }
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsOpen(false);
        triggerRef.current?.focus();
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isOpen, setIsOpen, triggerRef]);

  if (!isOpen) return null;

  return (
    <ul
      ref={contentRef}
      className="menu bg-base-100 rounded-box z-50 min-w-[8rem] p-2 shadow-lg border border-base-300 absolute right-0 top-full mt-1"
    >
      {children}
    </ul>
  );
}

interface DropdownMenuItemProps extends LiHTMLAttributes<HTMLLIElement> {
  disabled?: boolean;
}

const DropdownMenuItem = forwardRef<HTMLLIElement, DropdownMenuItemProps>(
  ({ children, className, disabled, onClick, ...props }, ref) => {
    const { setIsOpen } = useDropdownMenu();

    return (
      <li
        ref={ref}
        className={className}
        onClick={(e) => {
          if (disabled) return;
          onClick?.(e);
          setIsOpen(false);
        }}
        {...props}
      >
        <button
          type="button"
          disabled={disabled}
          className={`flex w-full cursor-pointer select-none items-center gap-2 rounded-lg px-3 py-2 text-sm outline-none transition-colors hover:bg-base-200 focus:bg-base-200 ${disabled ? "pointer-events-none opacity-50" : ""}`}
        >
          {children}
        </button>
      </li>
    );
  },
);
DropdownMenuItem.displayName = "DropdownMenuItem";

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
};
