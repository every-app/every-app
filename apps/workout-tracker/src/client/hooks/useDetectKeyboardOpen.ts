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
    setOpen(false);

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
        setOpen(false);
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
