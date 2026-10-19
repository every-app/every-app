import {
  defineConfig,
  defineDocs,
  defineCollections,
  frontmatterSchema,
} from "fumadocs-mdx/config/zod-3";
import { z } from "zod";

export const docs = defineDocs({
  dir: "content/docs",
});

// Notes for the people building Every App, served at /docs/internal. Kept out
// of the user docs' sidebar, search, llms.txt and sitemap.
export const internal = defineDocs({
  dir: "content/internal",
});

export const blog = defineCollections({
  type: "doc",
  dir: "content/blog",
  schema: (frontmatterSchema as any).extend({
    author: z.string(),
    date: z.string(),
  }),
});

export default defineConfig();
