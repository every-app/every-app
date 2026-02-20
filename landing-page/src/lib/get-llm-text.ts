export type LlmPage = {
  url: string;
  path: string;
  data: {
    title?: string;
    description?: string;
    getText?: (type?: string) => Promise<string>;
  };
};

const docsRawFiles = import.meta.glob("../../content/docs/**/*.{md,mdx}", {
  query: "?raw",
  eager: true,
}) as Record<string, unknown>;

function stripFrontmatter(content: string): string {
  return content.replace(/^---[\s\S]*?---\s*/u, "").trim();
}

function getRawMarkdownByPagePath(pagePath: string): string | undefined {
  const normalized = pagePath.replace(/^\/+/u, "");
  const match = Object.entries(docsRawFiles).find(([key]) =>
    key.endsWith(`/${normalized}`),
  );

  if (!match) return undefined;

  const rawModule = match[1] as { default?: unknown } | string;
  const rawContent =
    typeof rawModule === "string"
      ? rawModule
      : typeof rawModule?.default === "string"
        ? rawModule.default
        : typeof rawModule?.default === "function"
          ? (() => {
              try {
                const rendered = rawModule.default({}) as { type?: unknown };
                return typeof rendered?.type === "string"
                  ? rendered.type
                  : undefined;
              } catch {
                return undefined;
              }
            })()
          : undefined;

  if (!rawContent) return undefined;
  return stripFrontmatter(rawContent);
}

async function getProcessedMarkdown(page: LlmPage): Promise<string> {
  if (typeof page.data.getText === "function") {
    try {
      const processed = await page.data.getText("processed");
      if (processed.trim().length > 0) return processed.trim();
    } catch {
      // Fall back to raw markdown from Vite glob import.
    }
  }

  const raw = getRawMarkdownByPagePath(page.path);
  if (raw) return raw;

  throw new Error(`Unable to load markdown for page: ${page.path}`);
}

export async function getLLMText(page: LlmPage): Promise<string> {
  const body = await getProcessedMarkdown(page);
  const title = page.data.title?.trim() || page.url;
  const description = page.data.description?.trim();

  return [
    `# ${title}`,
    `URL: ${page.url}`,
    description ? `Description: ${description}` : null,
    "",
    body,
  ]
    .filter(Boolean)
    .join("\n");
}
