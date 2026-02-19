import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { findBestDateTokenMatch } from "@/client/lib/date-token-matcher";

const DATE_TOKEN_DECORATION_PLUGIN_KEY = new PluginKey(
  "dateTokenDecorationPlugin",
);

function buildDecorations(doc: Parameters<typeof DecorationSet.create>[0]) {
  const decorations: Decoration[] = [];

  doc.descendants((node, pos) => {
    if (!node.isTextblock) return;

    const match = findBestDateTokenMatch(node.textContent);
    if (!match) return;

    const from = pos + 1 + match.start;
    const to = pos + 1 + match.end;
    if (to > from) {
      decorations.push(
        Decoration.inline(from, to, {
          class: "todo-date-token-highlight",
        }),
      );
    }
  });

  return DecorationSet.create(doc, decorations);
}

export const DateTokenDecoration = Extension.create({
  name: "dateTokenDecoration",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: DATE_TOKEN_DECORATION_PLUGIN_KEY,
        state: {
          init: (_, { doc }) => buildDecorations(doc),
          apply: (tr, old, _, newState) => {
            if (tr.docChanged) {
              return buildDecorations(newState.doc);
            }
            return old.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations: (state) =>
            DATE_TOKEN_DECORATION_PLUGIN_KEY.getState(state),
        },
      }),
    ];
  },
});
