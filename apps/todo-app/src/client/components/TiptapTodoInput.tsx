import { useEffect, useMemo, useRef, type PointerEvent } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import type { Editor, JSONContent } from "@tiptap/core";
import { DateTokenDecoration } from "@/client/editor/extensions/DateTokenDecoration";

interface TiptapTodoInputProps {
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
  variant?: "composer" | "inline";
  inputId?: string;
  placeholder?: string;
  autoFocus?: boolean;
  focused?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
  onEscape?: () => void;
  onEnter?: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
  onPointerDown?: (event: PointerEvent<HTMLDivElement>) => void;
  className?: string;
}

export function TiptapTodoInput({
  value,
  onChange,
  multiline = false,
  variant = "composer",
  inputId,
  placeholder = "New todo...",
  autoFocus,
  focused,
  disabled = false,
  ariaLabel = "Todo title",
  onEscape,
  onEnter,
  onFocus,
  onBlur,
  onPointerDown,
  className,
}: TiptapTodoInputProps) {
  const isApplyingExternalValueRef = useRef(false);
  const latestOnChangeRef = useRef(onChange);
  latestOnChangeRef.current = onChange;

  const editor = useEditor({
    immediatelyRender: false,
    autofocus: autoFocus ? "end" : false,
    editable: !disabled,
    extensions: [
      StarterKit.configure({
        heading: false,
        blockquote: false,
        codeBlock: false,
        horizontalRule: false,
        bulletList: false,
        orderedList: false,
      }),
      Placeholder.configure({
        placeholder,
      }),
      DateTokenDecoration,
    ],
    content: toDocContent(value),
    onUpdate: ({ editor: instance }) => {
      if (isApplyingExternalValueRef.current) return;
      latestOnChangeRef.current(getEditorText(instance));
    },
    editorProps: {
      attributes: {
        id: inputId ?? "",
        "aria-label": ariaLabel,
        class: `todo-tiptap-input__editor${multiline ? " todo-tiptap-input__editor--multiline" : " todo-tiptap-input__editor--singleline"}`,
      },
      handleKeyDown: (view, event) => {
        if (disabled) return false;

        if (event.key === "Escape") {
          event.preventDefault();
          onEscape?.();
          return true;
        }

        if (
          event.key === "Enter" &&
          !event.shiftKey &&
          (onEnter || !multiline)
        ) {
          event.preventDefault();
          if (onEnter) {
            onEnter();
            return true;
          }

          if (!multiline) {
            const form = view.dom.closest("form");
            if (form instanceof HTMLFormElement) {
              form.requestSubmit();
            }
          }
          return true;
        }

        return false;
      },
      handleDOMEvents: {
        focus: () => {
          onFocus?.();
          return false;
        },
        blur: () => {
          onBlur?.();
          return false;
        },
      },
    },
  });

  useEffect(() => {
    if (!editor) return;
    const editorText = getEditorText(editor);
    if (editorText === value) return;

    isApplyingExternalValueRef.current = true;
    editor.commands.setContent(toDocContent(value));
    isApplyingExternalValueRef.current = false;
  }, [editor, value]);

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!disabled);
  }, [disabled, editor]);

  useEffect(() => {
    if (!editor || !focused || disabled) return;
    editor.chain().focus("end").run();
  }, [disabled, editor, focused]);

  const wrapperClassName = useMemo(() => {
    if (className) return className;
    if (variant === "inline") {
      return "todo-tiptap-input todo-tiptap-input--inline";
    }
    return multiline
      ? "todo-tiptap-input todo-tiptap-input--multiline"
      : "todo-tiptap-input todo-tiptap-input--singleline input w-full focus:border-primary focus:bg-primary/10 transition-colors duration-200";
  }, [className, multiline, variant]);

  return (
    <div
      className={wrapperClassName}
      onPointerDown={(event) => {
        onPointerDown?.(event);
        if (event.defaultPrevented) return;
        if (!editor) return;
        if (disabled) return;
        const target = event.target as HTMLElement;
        if (target.closest(".todo-tiptap-input__editor")) return;
        event.preventDefault();
        editor.chain().focus("end").run();
      }}
    >
      <EditorContent editor={editor} />
    </div>
  );
}

function getEditorText(editor: Editor): string {
  return editor.state.doc.textBetween(
    0,
    editor.state.doc.content.size,
    "\n",
    "\n",
  );
}

function toDocContent(value: string): JSONContent {
  const lines = value.split("\n");
  return {
    type: "doc",
    content: lines.map((line) => ({
      type: "paragraph",
      content: line ? [{ type: "text", text: line }] : [],
    })),
  };
}
