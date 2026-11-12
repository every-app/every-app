import defaultMdxComponents from "fumadocs-ui/mdx";
import { Step, Steps } from "fumadocs-ui/components/steps";
import type { MDXComponents } from "mdx/types";
import { CopySetupPrompt } from "@/components/copy-setup-prompt";

export const mdxComponents = {
  ...defaultMdxComponents,
  CopySetupPrompt,
  Step,
  Steps,
} satisfies MDXComponents;
