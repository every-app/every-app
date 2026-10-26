import Slugger from "github-slugger";
import { Marked, type Tokens } from "marked";

/** A heading of the table of contents (fumadocs' TOCItemType with a text title, so it serializes). */
export interface AgentTocItem {
  title: string;
  url: string;
  depth: number;
}

const headingId = /\s*\[#([^\]]+?)\]\s*$/;

const unescape = (text: string) =>
  text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

/** A heading's text for the table of contents, inline markup flattened. */
function flatten(tokens: Tokens.Generic[]): string {
  return tokens
    .map((token) =>
      "tokens" in token && Array.isArray(token.tokens)
        ? flatten(token.tokens as Tokens.Generic[])
        : typeof token.text === "string"
          ? unescape(token.text)
          : "",
    )
    .join("");
}

const escapeHtml = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * A page's body as HTML for /docs/agent/<page>, with its table of contents.
 * The markup is what fumadocs-ui gives the user docs, so the same styles
 * apply: every heading carries the id its Markdown names (`## Exit codes
 * [#exit-codes]`, what the served files have on every heading) and links to
 * itself, a table scrolls sideways in its wrapper, a code block is a figure
 * with one span per line (plain, not highlighted: the pages are references
 * an agent reads as Markdown), an external link opens in a new tab.
 */
export function renderAgentPage(markdown: string): {
  html: string;
  toc: AgentTocItem[];
} {
  const toc: AgentTocItem[] = [];
  const slugger = new Slugger();
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth }) {
        let id: string | undefined;
        const last = tokens.at(-1);
        if (last?.type === "text") {
          const match = headingId.exec(last.raw);
          if (match) {
            id = match[1];
            last.raw = last.raw.slice(0, match.index);
            last.text = last.text.replace(headingId, "");
          }
        }
        const title = flatten(tokens);
        id ??= slugger.slug(title);
        toc.push({ title, url: `#${id}`, depth });
        return `<h${depth} id="${id}" class="group/heading flex scroll-m-28 flex-row items-center gap-1"><a data-card href="#${id}">${this.parser.parseInline(tokens)}</a></h${depth}>\n`;
      },
      link({ href, title, tokens }) {
        const text = this.parser.parseInline(tokens);
        const attrs = [`href="${href}"`];
        if (title) attrs.push(`title="${title}"`);
        if (/^https?:\/\//.test(href))
          attrs.push('rel="noreferrer noopener"', 'target="_blank"');
        return `<a ${attrs.join(" ")}>${text}</a>`;
      },
      table(token) {
        const header = `<tr>${token.header.map((cell) => this.tablecell(cell)).join("")}</tr>`;
        const body = token.rows
          .map(
            (row) =>
              `<tr>${row.map((cell) => this.tablecell(cell)).join("")}</tr>`,
          )
          .join("");
        return `<div class="relative overflow-auto prose-no-margin my-6"><table><thead>${header}</thead><tbody>${body}</tbody></table></div>\n`;
      },
      code({ text, lang }) {
        const lines = text
          .split("\n")
          .map(
            (line) =>
              `<span class="line"><span>${escapeHtml(line)}</span></span>`,
          )
          .join("\n");
        const language = lang ? ` data-language="${escapeHtml(lang)}"` : "";
        return `<figure class="my-4 bg-fd-card rounded-xl shiki relative border not-prose overflow-hidden text-sm"${language}><div class="text-[0.8125rem] py-3.5 overflow-auto max-h-[600px] fd-scroll-container"><pre class="min-w-full w-max *:flex *:flex-col"><code>${lines}</code></pre></div></figure>\n`;
      },
      html({ text }) {
        // An HTML comment (a generated page's "Generated from …" note) stays out of the page.
        return text.replace(/<!--[\s\S]*?-->/g, "");
      },
    },
  });
  const html = marked.parse(markdown, { async: false });
  return { html, toc };
}
