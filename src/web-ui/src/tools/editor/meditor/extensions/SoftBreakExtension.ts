import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

// Markdown soft breaks (a single newline inside a paragraph) mean "space", not
// "line break". We keep the newline in the document so saving preserves the
// file's original wrapping, and only relax whitespace collapsing on that line
// ending, so `.ProseMirror { white-space: break-spaces }` stops turning a
// hard-wrapped source paragraph into a column as wide as the source lines.
export const softBreakPluginKey = new PluginKey('softBreak');

const SOFT_BREAK_CLASS = 'm-editor-soft-break';

// CRLF files keep both characters in the same text node, and CR is a segment
// break on its own, so the decoration has to cover the whole line ending.
const SOFT_BREAK_PATTERN = /\r?\n/g;

function collectSoftBreaks(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = [];

  doc.descendants((node: ProseMirrorNode, pos: number, parent: ProseMirrorNode | null) => {
    if (!node.isText || parent?.type.spec.code) {
      return;
    }

    const text = node.text ?? '';
    SOFT_BREAK_PATTERN.lastIndex = 0;
    for (let match = SOFT_BREAK_PATTERN.exec(text); match; match = SOFT_BREAK_PATTERN.exec(text)) {
      const from = pos + match.index;
      decorations.push(Decoration.inline(from, from + match[0].length, { class: SOFT_BREAK_CLASS }));
    }
  });

  return DecorationSet.create(doc, decorations);
}

export const SoftBreakExtension = Extension.create({
  name: 'softBreak',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: softBreakPluginKey,
        state: {
          init: (_config: unknown, state: EditorState) => collectSoftBreaks(state.doc),
          apply: (transaction: Transaction, decorations: DecorationSet) => (
            transaction.docChanged ? collectSoftBreaks(transaction.doc) : decorations
          ),
        },
        props: {
          decorations(state: EditorState) {
            return softBreakPluginKey.getState(state) as DecorationSet | undefined;
          },
        },
      }),
    ];
  },
});
