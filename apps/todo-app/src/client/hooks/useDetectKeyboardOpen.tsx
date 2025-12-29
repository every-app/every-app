import { useEffect, useState } from "react";

const isKeyboardInput = (elem: HTMLElement) =>
  (elem.tagName === "INPUT" &&
    !["button", "submit", "checkbox", "file", "image"].includes(
      (elem as HTMLInputElement).type,
    )) ||
  elem.tagName === "TEXTAREA" ||
  elem.hasAttribute("contenteditable");

const useDetectKeyboardOpen = () => {
  const [isOpen, setOpen] = useState(false);

  useEffect(() => {
    // Check initial state based on current active element
    const checkActiveElement = (): boolean => {
      const activeElement = document.activeElement as HTMLElement | null;
      return activeElement !== null && isKeyboardInput(activeElement);
    };

    setOpen(checkActiveElement());

    const handleFocusIn = (e: FocusEvent) => {
      if (!e.target) {
        return;
      }
      const target = e.target as HTMLElement;
      if (isKeyboardInput(target)) {
        setOpen(true);
      }
    };

    const handleFocusOut = (e: FocusEvent) => {
      if (!e.target) {
        return;
      }
      const target = e.target as HTMLElement;
      if (isKeyboardInput(target)) {
        // Use setTimeout to check if focus moved to another keyboard input
        // This handles the case where focus moves between inputs
        // and also handles route changes where element is removed from DOM
        setTimeout(() => {
          setOpen(checkActiveElement());
        }, 0);
      }
    };

    document.addEventListener("focusin", handleFocusIn);
    document.addEventListener("focusout", handleFocusOut);

    return () => {
      document.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("focusout", handleFocusOut);
      setOpen(false);
    };
  }, []);

  return isOpen;
};

export default useDetectKeyboardOpen;
