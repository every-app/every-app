import { useDialogControl } from "@/client/hooks/useDialogControl";
import { KEYBOARD_SHORTCUTS } from "@/client/lib/keyboard-shortcuts";
import { Modal } from "@/client/components/ui/modal";

interface KeyboardShortcutsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

function KeyBadge({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="px-2 py-1 text-xs font-mono bg-base-300 border border-base-content/20 rounded-md min-w-[24px] text-center">
      {children}
    </kbd>
  );
}

export function KeyboardShortcutsModal({
  isOpen,
  onClose,
}: KeyboardShortcutsModalProps) {
  const dialogRef = useDialogControl(isOpen);

  return (
    <Modal dialogRef={dialogRef} onClose={onClose} boxClassName="max-w-md">
      <h3 className="font-bold text-lg mb-4">Keyboard Shortcuts</h3>
      <div className="space-y-6">
        {KEYBOARD_SHORTCUTS.map((section) => (
          <div key={section.category}>
            <h4 className="text-sm font-medium text-base-content/60 mb-3">
              {section.category}
            </h4>
            <div className="space-y-2">
              {section.items.map((shortcut) => (
                <div
                  key={shortcut.description}
                  className="flex items-center justify-between"
                >
                  <span className="text-sm">{shortcut.description}</span>
                  <div className="flex items-center gap-1">
                    {shortcut.keys.map((key, index) => (
                      <span key={key} className="flex items-center gap-1">
                        <KeyBadge>{key}</KeyBadge>
                        {index < shortcut.keys.length - 1 &&
                          shortcut.separator && (
                            <span className="text-xs text-base-content/40">
                              {shortcut.separator === "plus"
                                ? "+"
                                : shortcut.separator}
                            </span>
                          )}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="modal-action">
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}
