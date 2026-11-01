import defaultMdxComponents from "fumadocs-ui/mdx";
import { Step, Steps } from "fumadocs-ui/components/steps";
import type { MDXComponents } from "mdx/types";

export const mdxComponents = {
  ...defaultMdxComponents,
  Step,
  Steps,
} satisfies MDXComponents;
