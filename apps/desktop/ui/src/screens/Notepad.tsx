import { cn } from "cn";
import { Fragment, useLayoutEffect, useRef } from "react";
import { markdownShortcut } from "../lib/markdown-shortcuts";
import { parseLine, type LinePart } from "../lib/notepad-lines";

// The textarea and the layer drawn behind it must lay text out identically.
const TEXT =
  "whitespace-pre-wrap break-words text-[15px] leading-[1.7] [font-kerning:none] [tab-size:2]";

/**
 * The notepad: plain Markdown in a calm, auto-growing textarea, with list
 * and bold/italic shortcuts. Behind the (transparent) text, a layer draws the
 * same characters with list markers as dots and quieter `#`, `1.` and `[ ]`,
 * so lists read as lists without a rich editor. Controlled; the caller saves.
 */
export function Notepad({
  value,
  onChange,
  placeholder = "Write notes…",
  autoFocus,
  readOnly,
  className,
  label = "Notes",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  readOnly?: boolean;
  className?: string;
  label?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // Grow with the text so the page, not the box, scrolls.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  return (
    // Both layers sit in one grid cell, so they share padding and width exactly.
    <div
      className={cn("grid cursor-text", className)}
      onMouseDown={(event) => {
        // A click in the empty space under the text puts the caret at the end.
        if (event.target !== event.currentTarget || !ref.current) return;
        event.preventDefault();
        const end = ref.current.value.length;
        ref.current.focus();
        ref.current.setSelectionRange(end, end);
      }}
    >
      <div
        aria-hidden
        data-slot="notepad-lines"
        className={cn(
          TEXT,
          "pointer-events-none [grid-area:1/1] text-foreground",
        )}
      >
        {value.split("\n").map((line, i) => (
          <div key={i}>{line ? <Line parts={parseLine(line)} /> : "​"}</div>
        ))}
      </div>
      <textarea
        ref={ref}
        data-slot="notepad"
        aria-label={label}
        value={value}
        readOnly={readOnly}
        autoFocus={autoFocus}
        placeholder={placeholder}
        spellCheck
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (readOnly) return;
          const el = event.currentTarget;
          const edit = markdownShortcut(
            el.value,
            el.selectionStart,
            el.selectionEnd,
            {
              key: event.key,
              shift: event.shiftKey,
              meta: event.metaKey || event.ctrlKey,
            },
          );
          if (!edit) return;
          event.preventDefault();
          el.setSelectionRange(edit.from, edit.to);
          // insertText keeps the browser's undo stack; fall back if it's gone.
          const inserted =
            typeof document.execCommand === "function" &&
            document.execCommand("insertText", false, edit.text);
          if (!inserted) {
            el.setRangeText(edit.text, edit.from, edit.to, "end");
            onChange(el.value);
          }
          el.setSelectionRange(edit.selStart, edit.selEnd);
        }}
        className={cn(
          TEXT,
          "block w-full resize-none self-start overflow-hidden bg-transparent p-0 [grid-area:1/1] text-transparent caret-foreground outline-none selection:bg-ring/25 placeholder:text-muted-foreground/70",
        )}
      />
    </div>
  );
}

function Line({ parts }: { parts: LinePart[] }) {
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {part.kind === "bullet" ? (
            <span data-part="bullet" className="relative text-transparent">
              {part.text}
              <span className="absolute left-1/2 top-1/2 size-[5px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/45" />
            </span>
          ) : part.kind === "marker" ? (
            <span data-part="marker" className="text-muted-foreground/70">
              {part.text}
            </span>
          ) : part.kind === "done" ? (
            <span
              data-part="done"
              className="text-muted-foreground line-through decoration-foreground/30"
            >
              {part.text}
            </span>
          ) : (
            part.text
          )}
        </Fragment>
      ))}
    </>
  );
}
