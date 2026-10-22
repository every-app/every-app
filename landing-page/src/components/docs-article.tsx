import type { ReactNode } from "react";
import { use } from "react";
import type { PageData } from "fumadocs-core/source";
import type { MacroAsyncDocEntry } from "fumadocs-mdx/runtime/macro";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from "fumadocs-ui/layouts/docs/page";
import { mdxComponents } from "@/components/mdx";

export function DocsArticle({
  entry,
  actions,
}: {
  entry: MacroAsyncDocEntry<PageData>;
  actions?: ReactNode;
}) {
  const { toc } = use(entry.load());
  const MDX = entry.body;

  return (
    <DocsPage toc={toc}>
      <DocsTitle>{entry.title}</DocsTitle>
      <DocsDescription>{entry.description}</DocsDescription>
      {actions}
      <DocsBody>
        <MDX components={mdxComponents} />
      </DocsBody>
    </DocsPage>
  );
}
