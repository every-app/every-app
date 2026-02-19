import { useMemo } from "react";
import { CalendarClock, X } from "lucide-react";
import {
  extractDueDateFromInput,
  formatDueDateBadge,
  type DueDateExtractionResult,
} from "@/client/lib/due-date-parser";
import { TiptapTodoInput } from "@/client/components/TiptapTodoInput";

interface NewTodoComposerProps {
  rawValue: string;
  onRawValueChange: (value: string) => void;
  multiline?: boolean;
  inputId?: string;
  placeholder?: string;
  autoFocus?: boolean;
  onEscape?: () => void;
  parsedTodo?: DueDateExtractionResult;
}

export function NewTodoComposer({
  rawValue,
  onRawValueChange,
  multiline = false,
  inputId,
  placeholder = "New todo...",
  autoFocus,
  onEscape,
  parsedTodo,
}: NewTodoComposerProps) {
  const parsed = useMemo(
    () => parsedTodo ?? extractDueDateFromInput(rawValue),
    [parsedTodo, rawValue],
  );

  return (
    <div className="space-y-2">
      <TiptapTodoInput
        inputId={inputId}
        value={rawValue}
        onChange={onRawValueChange}
        multiline={multiline}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onEscape={onEscape}
      />

      {parsed.dueDate && parsed.matchedText && (
        <div className="flex items-center gap-2 text-xs">
          <span className="inline-flex items-center gap-1 rounded-full border border-primary/20 bg-primary/10 px-2 py-1 text-primary">
            <CalendarClock className="h-3 w-3" />
            Due {formatDueDateBadge(parsed.dueDate)}
          </span>
          <span className="text-base-content/50">
            from “{parsed.matchedText}”
          </span>
          <button
            type="button"
            onClick={() => onRawValueChange(parsed.title)}
            className="inline-flex items-center gap-1 text-base-content/60 hover:text-base-content"
            aria-label="Remove parsed due date"
          >
            <X className="h-3 w-3" />
            Clear
          </button>
        </div>
      )}
    </div>
  );
}
