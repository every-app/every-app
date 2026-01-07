import { ReactNode, createContext, useContext, useRef, useEffect } from "react";
import { motion } from "framer-motion";

/**
 * Drag state management using refs and pub/sub to avoid re-renders.
 *
 * AnimatedTodoItem needs `overflow: hidden` for collapse animations, but this
 * clips dnd-kit's transformed items during drag. We toggle overflow via direct
 * DOM manipulation when drag state changes, avoiding expensive re-renders.
 *
 * Usage is optional - AnimatedTodoItem works without DragStateProvider, but
 * won't have drag-aware overflow handling.
 */

interface DragContextValue {
  isDraggingRef: React.MutableRefObject<boolean>;
  subscribe: (callback: () => void) => () => void;
  notifySubscribers: () => void;
}

const DragContext = createContext<DragContextValue | null>(null);

/**
 * Provider that manages drag state via mutable ref and pub/sub pattern.
 * Wrap your draggable list area with this provider.
 */
export function DragStateProvider({ children }: { children: ReactNode }) {
  const isDraggingRef = useRef(false);
  const subscribersRef = useRef(new Set<() => void>());

  // Use a ref for the context value to ensure it's stable across renders
  const contextValue = useRef<DragContextValue>({
    isDraggingRef,
    subscribe: (callback) => {
      subscribersRef.current.add(callback);
      return () => subscribersRef.current.delete(callback);
    },
    notifySubscribers: () => {
      subscribersRef.current.forEach((cb) => cb());
    },
  });

  return (
    <DragContext.Provider value={contextValue.current}>
      {children}
    </DragContext.Provider>
  );
}

/**
 * Hook to control drag state from a parent component.
 * Call setDragging(true) on drag start and setDragging(false) on drag end/cancel.
 * This updates the ref and notifies all subscribed AnimatedTodoItem components.
 */
export function useDragStateControl() {
  const context = useContext(DragContext);
  if (!context) {
    throw new Error(
      "useDragStateControl must be used within DragStateProvider",
    );
  }

  return {
    setDragging: (value: boolean) => {
      context.isDraggingRef.current = value;
      context.notifySubscribers();
    },
  };
}

interface AnimatedTodoItemProps {
  children: ReactNode;
  /** Whether animations are enabled (false = render without animating) */
  isAnimationEnabled?: boolean;
}

/**
 * Provides collapse/expand animations for todo items.
 *
 * When used inside a DragStateProvider, automatically toggles overflow to
 * prevent dnd-kit items from being clipped during drag. Works without the
 * provider but won't have drag-aware overflow handling.
 */
export function AnimatedTodoItem({
  children,
  isAnimationEnabled = true,
}: AnimatedTodoItemProps) {
  const ref = useRef<HTMLDivElement>(null);
  const context = useContext(DragContext);

  // Subscribe to drag state changes (if DragStateProvider exists) and update
  // overflow via DOM manipulation to avoid re-renders.
  useEffect(() => {
    if (!context || !ref.current) return;

    const updateOverflow = () => {
      if (ref.current) {
        // During drag: overflow visible so transformed items aren't clipped
        // Not dragging: overflow hidden so height collapse animation works
        ref.current.style.overflow = context.isDraggingRef.current
          ? "visible"
          : "hidden";
      }
    };

    // Set initial overflow state
    updateOverflow();

    // Subscribe to future drag state changes
    return context.subscribe(updateOverflow);
  }, [context]);

  return (
    <motion.div
      ref={ref}
      initial={isAnimationEnabled ? { opacity: 0, height: 0 } : false}
      animate={{ opacity: 1, height: "auto" }}
      exit={
        isAnimationEnabled
          ? {
              opacity: 0,
              height: 0,
              transition: {
                height: { duration: 0.15, ease: [0.4, 0, 0.2, 1] },
                opacity: { duration: 0.12 },
              },
            }
          : undefined
      }
      transition={{
        height: { duration: 0.25, ease: [0.4, 0, 0.2, 1] },
        opacity: { duration: 0.3 },
      }}
      style={{ overflow: "hidden" }}
    >
      {children}
    </motion.div>
  );
}
