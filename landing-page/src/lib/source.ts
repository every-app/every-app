import { loader } from "fumadocs-core/source";
// Keep this deep import for now: the public "fumadocs-mdx/runtime/vite" entry
// resolves to the browser runtime in our SSR build, which breaks sourceAsync.
import { fromConfig } from "../../node_modules/fumadocs-mdx/dist/runtime/vite/server.js";
import { docs, blog } from "../../source.generated";
import type * as Config from "../../source.config";

const serverCreate = fromConfig<typeof Config>();

const docsSourceData = await serverCreate.sourceAsync(docs.doc, docs.meta);

export const source = loader({
  source: docsSourceData,
  baseUrl: "/docs",
  plugins: [
    {
      transformPageTree: {
        file(node) {
          if (node.url === "/llms.txt") {
            return {
              ...node,
              external: true,
            };
          }

          return node;
        },
      },
    },
  ],
});

export const blogSource = loader({
  source: await serverCreate.sourceAsync(blog, {} as Record<string, never>),
  baseUrl: "/blogs",
});

export { docs, blog };
