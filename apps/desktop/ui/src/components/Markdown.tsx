import type { ReactNode } from "react";

/** **bold** and `code` inside a line; everything else stays text. */
function inline(text: string): ReactNode[] {
  return text
    .split(/(\*\*[^*]+\*\*|`[^`]+`)/)
    .filter(Boolean)
    .map((part, i) => {
      if (part.startsWith("**") && part.endsWith("**")) {
        return <strong key={i}>{part.slice(2, -2)}</strong>;
      }
      if (part.startsWith("`") && part.endsWith("`")) {
        return (
          <code key={i} className="rounded bg-muted px-1 text-[0.9em]">
            {part.slice(1, -1)}
          </code>
        );
      }
      return part.replace(/^_(.*)_$/, "$1");
    });
}

/**
 * The notes are Markdown with headings, bullets (nested by indent, with
 * task boxes) and paragraphs; that is all this renders.
 */
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let bullets: { depth: number; text: string; done: boolean | null }[] = [];
  const flush = () => {
    if (!bullets.length) return;
    blocks.push(
      <ul key={blocks.length} className="space-y-1.5">
        {bullets.map((bullet, i) => (
          <li
            key={i}
            className="flex gap-2.5"
            style={{ paddingLeft: `${bullet.depth * 1.5}rem` }}
          >
            {bullet.done === null ? (
              <span
                aria-hidden
                className={
                  bullet.depth
                    ? "mt-2.5 size-1.5 shrink-0 rounded-full border border-muted-foreground"
                    : "mt-2.5 size-1.5 shrink-0 rounded-full bg-muted-foreground"
                }
              />
            ) : (
              <input
                type="checkbox"
                checked={bullet.done}
                readOnly
                className="mt-1.5 size-3.5 shrink-0 accent-primary"
              />
            )}
            <span>{inline(bullet.text)}</span>
          </li>
        ))}
      </ul>,
    );
    bullets = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const bullet = /^(\s*)(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
    if (bullet) {
      const task = /^\[( |x)\]\s*(.*)$/i.exec(bullet[2]!);
      bullets.push({
        depth: Math.min(3, Math.floor(bullet[1]!.length / 2)),
        text: task ? task[2]! : bullet[2]!,
        done: task ? task[1]!.toLowerCase() === "x" : null,
      });
      continue;
    }
    flush();
    if (!line.trim()) continue;
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push(
        <h3
          key={blocks.length}
          className="pt-4 text-base font-semibold first:pt-0"
        >
          {inline(heading[2]!)}
        </h3>,
      );
    } else {
      blocks.push(<p key={blocks.length}>{inline(line)}</p>);
    }
  }
  flush();
  return <div className="space-y-2.5 leading-relaxed">{blocks}</div>;
}
