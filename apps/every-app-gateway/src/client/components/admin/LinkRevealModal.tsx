import type { ReactNode } from "react";
import { CodeBlock } from "@/client/components/CodeBlock";
import { Button } from "@/client/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/client/components/ui/dialog";

export interface RevealedLink {
  title: string;
  description: string;
  url: string;
  expiresAt: Date | string;
}

interface LinkRevealModalProps {
  link: RevealedLink | null;
  onClose: () => void;
}

/**
 * The body of a dialog that hands the admin a one-time link: the link with a
 * copy button, a note on how long it works, and Done. It fills a
 * `DialogContent` with `grid-cols-1`, so a long link scrolls in its box.
 */
export function LinkRevealContent({
  title,
  description,
  url,
  notice,
  footnote,
  onDone,
}: {
  title: string;
  description: ReactNode;
  url: string;
  /** An Alert above the link, for example why it was not emailed. */
  notice?: ReactNode;
  footnote: ReactNode;
  onDone: () => void;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      {notice}
      <CodeBlock code={url} successMessage="Link copied" />
      <p className="text-xs text-muted-foreground">{footnote}</p>
      <DialogFooter>
        <Button onClick={onDone}>Done</Button>
      </DialogFooter>
    </>
  );
}

/** Show a one-time link (invitation, password reset) for the admin to share. */
export function LinkRevealModal({ link, onClose }: LinkRevealModalProps) {
  if (!link) return null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="grid-cols-1 sm:max-w-md"
      >
        <LinkRevealContent
          title={link.title}
          description={link.description}
          url={link.url}
          footnote={
            <>
              Works once, until {new Date(link.expiresAt).toLocaleString()}.
              Share it privately: anyone with this link can use it.
            </>
          }
          onDone={onClose}
        />
      </DialogContent>
    </Dialog>
  );
}
