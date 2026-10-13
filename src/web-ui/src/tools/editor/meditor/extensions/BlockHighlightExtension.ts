import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export const blockHighlightPluginKey = new PluginKey<string | null>('blockHighlight');

// Navigation highlights belong to the view. Mutating a contenteditable node's
// class directly makes ProseMirror reparse its DOM as a document edit.
export const BlockHighlightExtension = Extension.create({
  name: 'blockHighlight',

  addProseMirrorPlugins() {
    return [new Plugin<string | null>({
      key: blockHighlightPluginKey,
      state: {
        init: () => null,
        apply: (transaction, blockId) => {
          const nextBlockId = transaction.getMeta(blockHighlightPluginKey) as string | null | undefined;
          return nextBlockId === undefined ? blockId : nextBlockId;
        },
      },
      props: {
        decorations(state) {
          const blockId = blockHighlightPluginKey.getState(state);
          if (!blockId) return DecorationSet.empty;
          const decorations: Decoration[] = [];
          state.doc.forEach((node, offset) => {
            if (node.attrs.blockId === blockId) {
              decorations.push(Decoration.node(offset, offset + node.nodeSize, {
                class: 'm-editor-tiptap-block-highlighted',
              }));
            }
          });
          return DecorationSet.create(state.doc, decorations);
        },
      },
    })];
  },
});
